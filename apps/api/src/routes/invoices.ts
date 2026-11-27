import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  confirmLines,
  createDraft,
  InvoiceDraft,
  matchInvoiceLines,
  ocrProviderFromEnv,
  SampleInvoiceProvider,
} from '../invoice';
import { resolveStoreId, withTransaction } from '../db';

const scanSchema = z.object({
  storeId: z.string().uuid(),
  /** Base64 image (or anything the configured OCR provider accepts). Ignored by the sample provider. */
  imageBase64: z.string().optional(),
});

const confirmSchema = z.object({
  lineIds: z.array(z.string().uuid()).min(1),
});

export function invoicesRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/invoices?storeId= — list invoice scans (drafts included).
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = typeof req.query.storeId === 'string' ? req.query.storeId : null;
      const { rows } = await pool.query(
        storeId
          ? `SELECT id, store_id, supplier, invoice_number, status, created_at, updated_at
               FROM invoice_scans WHERE store_id = $1 ORDER BY created_at DESC`
          : `SELECT id, store_id, supplier, invoice_number, status, created_at, updated_at
               FROM invoice_scans ORDER BY created_at DESC`,
        storeId ? [storeId] : [],
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/invoices/sample — the fixed Core-Mark sample invoice as a
   * persisted DRAFT (same flow as a scan, no photo). Draft-only: nothing
   * posts until lines are confirmed via POST /invoices/:id/confirm.
   * Must be registered before GET /:id so 'sample' is not read as an id.
   */
  router.get('/sample', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requested = typeof req.query.storeId === 'string' ? req.query.storeId : null;
      const storeId = requested
        ? await resolveStoreId(pool, requested)
        : (
            await pool.query(
              `SELECT id FROM stores ORDER BY code LIMIT 1`,
            )
          ).rows[0]?.id;
      if (!storeId) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }
      const extracted = await new SampleInvoiceProvider().extract('');
      const { rows: catalog } = await pool.query(
        `SELECT id, name, barcode, cost_cents FROM products`,
      );
      const matched = matchInvoiceLines(extracted.lines, catalog);
      const draft = await withTransaction(async (client) => {
        const { rows: scans } = await client.query(
          `INSERT INTO invoice_scans (store_id, supplier, invoice_number, status, raw)
           VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
          [storeId, extracted.supplier, extracted.invoiceNumber, JSON.stringify(extracted)],
        );
        const scanId: string = scans[0].id;
        const draftShape = createDraft({
          id: scanId,
          storeId,
          supplier: extracted.supplier,
          invoiceNumber: extracted.invoiceNumber,
          lines: matched,
        });
        for (const line of matched) {
          await client.query(
            `INSERT INTO invoice_lines
               (invoice_scan_id, product_id, name, barcode, qty, unit_cost_cents, status, confirmed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`,
            [scanId, line.productId, line.name, line.barcode ?? null, line.qty, line.unitCostCents, line.status],
          );
        }
        return draftShape;
      });
      const { rows: lines } = await pool.query(
        `SELECT id, product_id, name, barcode, qty, unit_cost_cents, status, confirmed
           FROM invoice_lines WHERE invoice_scan_id = $1 ORDER BY created_at`,
        [draft.id],
      );
      res.status(201).json({ ...draft, lines });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/invoices/:id — draft with its lines.
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows: scans } = await pool.query(
        `SELECT id, store_id, supplier, invoice_number, status, created_at, updated_at
           FROM invoice_scans WHERE id = $1`,
        [req.params.id],
      );
      if (scans.length === 0) {
        res.status(404).json({ error: 'Invoice not found' });
        return;
      }
      const { rows: lines } = await pool.query(
        `SELECT id, product_id, name, barcode, qty, unit_cost_cents, status, confirmed
           FROM invoice_lines WHERE invoice_scan_id = $1 ORDER BY created_at`,
        [req.params.id],
      );
      res.json({ ...scans[0], lines });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/invoices/scan — OCR an invoice into a DRAFT.
   * Nothing posts to the ledger here. The response is the draft; a human
   * must confirm lines (POST /invoices/:id/confirm) before any stock moves.
   */
  router.post('/scan', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = scanSchema.parse(req.body);

      const store = await pool.query(`SELECT id FROM stores WHERE id = $1`, [body.storeId]);
      if (store.rows.length === 0) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }

      const provider = ocrProviderFromEnv();
      const extracted = await provider.extract(body.imageBase64 ?? '');

      const { rows: catalog } = await pool.query(
        `SELECT id, name, barcode, cost_cents FROM products`,
      );
      const matched = matchInvoiceLines(extracted.lines, catalog);

      const draft = await withTransaction(async (client) => {
        const { rows: scans } = await client.query(
          `INSERT INTO invoice_scans (store_id, supplier, invoice_number, status, raw)
           VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
          [
            body.storeId,
            extracted.supplier,
            extracted.invoiceNumber,
            JSON.stringify(extracted),
          ],
        );
        const scanId: string = scans[0].id;
        const draftShape = createDraft({
          id: scanId,
          storeId: body.storeId,
          supplier: extracted.supplier,
          invoiceNumber: extracted.invoiceNumber,
          lines: matched,
        });
        for (const line of matched) {
          await client.query(
            `INSERT INTO invoice_lines
               (invoice_scan_id, product_id, name, barcode, qty, unit_cost_cents, status, confirmed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`,
            [
              scanId,
              line.productId,
              line.name,
              line.barcode ?? null,
              line.qty,
              line.unitCostCents,
              line.status,
            ],
          );
        }
        return draftShape;
      });

      // Return the persisted draft with real DB line ids, not the temp ones.
      const { rows: lines } = await pool.query(
        `SELECT id, product_id, name, barcode, qty, unit_cost_cents, status, confirmed
           FROM invoice_lines WHERE invoice_scan_id = $1 ORDER BY created_at`,
        [draft.id],
      );
      res.status(201).json({ ...draft, lines });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid scan request', details: err.issues });
        return;
      }
      if (err instanceof Error) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/invoices/:id/confirm — confirm lines; only confirmed + matched
   * lines post 'receive' movements. Unmatched lines cannot be confirmed;
   * confirming zero lines is rejected (400).
   */
  router.post('/:id/confirm', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = confirmSchema.parse(req.body);

      const result = await withTransaction(async (client) => {
        const { rows: scans } = await client.query(
          `SELECT id, store_id, supplier, invoice_number, status
             FROM invoice_scans WHERE id = $1 FOR UPDATE`,
          [req.params.id],
        );
        if (scans.length === 0) {
          return { status: 404 as const, body: { error: 'Invoice not found' } };
        }
        const scan = scans[0];
        const { rows: lineRows } = await client.query(
          `SELECT id, product_id, name, barcode, qty, unit_cost_cents, status, confirmed
             FROM invoice_lines WHERE invoice_scan_id = $1 ORDER BY created_at`,
          [req.params.id],
        );

        const draft: InvoiceDraft = {
          id: scan.id,
          storeId: scan.store_id,
          supplier: scan.supplier ?? '',
          invoiceNumber: scan.invoice_number ?? '',
          status: scan.status,
          lines: lineRows.map((r) => ({
            id: r.id,
            name: r.name,
            barcode: r.barcode ?? undefined,
            qty: r.qty,
            unitCostCents: r.unit_cost_cents,
            status: r.status,
            productId: r.product_id,
            matchReason: r.status === 'matched' ? 'matched in catalog' : 'No catalog match',
            confirmed: r.confirmed,
          })),
        };

        const { draft: updated, movements } = confirmLines(draft, body.lineIds);

        for (const m of movements) {
          await client.query(
            `INSERT INTO movements (store_id, product_id, type, qty_delta, cost_cents, note)
             VALUES ($1, $2, 'receive', $3, $4, $5)`,
            [m.storeId, m.productId, m.qty, m.costCents, m.note],
          );
        }
        for (const lineId of body.lineIds) {
          await client.query(
            `UPDATE invoice_lines SET confirmed = TRUE WHERE id = $1`,
            [lineId],
          );
        }
        await client.query(
          `UPDATE invoice_scans SET status = $1, updated_at = now() WHERE id = $2`,
          [updated.status, scan.id],
        );

        return {
          status: 200 as const,
          body: {
            invoiceId: scan.id,
            status: updated.status,
            confirmedLineIds: body.lineIds,
            movementsPosted: movements.length,
            movements,
          },
        };
      });

      res.status(result.status).json(result.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid confirm request', details: err.issues });
        return;
      }
      if (err instanceof Error) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
