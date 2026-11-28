import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { readInvoiceWithVision } from '../vision';
import { readInvoiceWithOpenAi } from '../openai';
import {
  confirmLines,
  createDraft,
  extractInvoiceHeader,
  InvoiceDraft,
  matchInvoiceLines,
  parseOcrRows,
  reconcileInvoice,
  SampleInvoiceProvider,
  TextOcrProvider,
} from '../invoice';
import { isUuid, resolveStoreId, withTransaction } from '../db';

const scanSchema = z.object({
  storeId: z.string().uuid(),
  /** Base64 image (kept for compatibility; the photo is read in the browser). */
  imageBase64: z.string().optional(),
  /** OCR text read from the photo by Tesseract.js in the browser. */
  ocrText: z.string().optional(),
  /** Rows rebuilt from Tesseract word positions (see InvoiceScan). */
  ocrRows: z.array(z.string()).optional(),
});

const confirmSchema = z.object({
  lineIds: z.array(z.string().uuid()).min(1),
});

export function invoicesRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/invoices?storeId= — list invoice scans (drafts included).
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawStoreId =
        typeof req.query.storeId === 'string' ? req.query.storeId : null;
      const storeId = rawStoreId ? await resolveStoreId(pool, rawStoreId) : null;
      if (rawStoreId && !storeId) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }
      const { rows } = await pool.query(
        storeId
          ? `SELECT id, store_id, supplier, invoice_number, status, created_at, updated_at
               FROM invoice_scans WHERE store_id = $1::uuid ORDER BY created_at DESC`
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

const manualSchema = z.object({
  storeId: z.string().uuid(),
  supplier: z.string().min(1).max(120),
  invoiceNumber: z.string().max(60).optional().default(''),
  lines: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        barcode: z.string().regex(/^\d{12}$/).optional(),
        qty: z.number().int().min(1),
        unitCostCents: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(100),
});

/**
 * POST /api/invoices/manual — type the invoice lines in by hand when OCR
 * cannot read a photo. Same draft-only flow as a scan: nothing posts until
 * lines are confirmed via POST /invoices/:id/confirm.
 */
router.post('/manual', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = manualSchema.parse(req.body);
    const store = await pool.query(`SELECT id FROM stores WHERE id = $1`, [body.storeId]);
    if (store.rows.length === 0) {
      res.status(404).json({ error: 'Store not found' });
      return;
    }
    const { rows: catalog } = await pool.query(
      `SELECT id, name, barcode, cost_cents FROM products`,
    );
    const matched = matchInvoiceLines(body.lines, catalog);
    const draft = await withTransaction(async (client) => {
      const { rows: scans } = await client.query(
        `INSERT INTO invoice_scans (store_id, supplier, invoice_number, status, raw)
         VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
        [
          body.storeId,
          body.supplier,
          body.invoiceNumber,
          JSON.stringify({ supplier: body.supplier, invoiceNumber: body.invoiceNumber, lines: body.lines, source: 'manual' }),
        ],
      );
      const scanId: string = scans[0].id;
      const draftShape = createDraft({
        id: scanId,
        storeId: body.storeId,
        supplier: body.supplier,
        invoiceNumber: body.invoiceNumber,
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
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid manual invoice', details: err.issues });
      return;
    }
    next(err);
  }
});

  // GET /api/invoices/:id — draft with its lines.
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isUuid(req.params.id)) {
        res.status(404).json({ error: 'Invoice not found' });
        return;
      }
      const { rows: scans } = await pool.query(
        `SELECT id, store_id, supplier, invoice_number, status, created_at, updated_at
           FROM invoice_scans WHERE id = $1::uuid`,
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

      const provider = new TextOcrProvider();
      let extracted: Awaited<ReturnType<typeof provider.extract>> | undefined;
      let reconText = body.ocrText ?? '';
      // OpenAI's own totals, when the vision model read them — more
      // reliable than scraping them out of OCR text.
      let reconOverride: { expectedTotalCents: number | null; expectedUnits: number | null } | null = null;
      try {
        // Exact-details path, first choice: GPT-4o vision on the server.
        // The phone's built-in reader (Tesseract) was tested every way on
        // the user's Red Bull invoice and never got all 6 lines right.
        // Any OpenAI failure falls back to the next reader, never fails
        // the scan outright.
        const openAiKey = process.env.OPENAI_API_KEY;
        if (body.imageBase64 && openAiKey) {
          try {
            const ai = await readInvoiceWithOpenAi(body.imageBase64, openAiKey);
            if (ai.lines.length > 0) {
              extracted = {
                supplier: ai.supplier,
                invoiceNumber: ai.invoiceNumber,
                lines: ai.lines,
              };
              reconOverride = {
                expectedTotalCents: ai.expectedTotalCents,
                expectedUnits: ai.expectedUnits,
              };
            }
          } catch (e) {
            console.warn('[invoice] OpenAI read failed, falling back:', e);
          }
        }
        // Exact-details path, second choice: Google Cloud Vision.
        const visionKey = process.env.GOOGLE_VISION_API_KEY;
        if (!extracted && body.imageBase64 && visionKey) {
          try {
            const vision = await readInvoiceWithVision(body.imageBase64, visionKey);
            const { supplier, invoiceNumber } = extractInvoiceHeader(vision.text);
            const visionLines = parseOcrRows(vision.rows);
            if (visionLines.length > 0) {
              extracted = { supplier, invoiceNumber, lines: visionLines };
              reconText = vision.text;
            }
          } catch (e) {
            console.warn('[invoice] Vision read failed, falling back to phone OCR:', e);
          }
        }
        if (!extracted) {
          // Rows rebuilt from word positions read the table far better than
          // plain OCR text, which scatters a row's fields across lines.
          // Fall back to plain text when no rows were sent.
          if (body.ocrRows && body.ocrRows.length > 0) {
            const rowsText = body.ocrRows.join('\n');
            const { supplier, invoiceNumber } = extractInvoiceHeader(rowsText);
            extracted = {
              supplier,
              invoiceNumber,
              lines: parseOcrRows(body.ocrRows),
            };
            reconText = rowsText;
            if (extracted.lines.length === 0) {
              throw new Error(
                'No invoice lines could be read from this photo. Try a closer, well-lit shot of the full invoice, or enter the lines manually.',
              );
            }
          } else {
            // Real scans must carry OCR text from the browser. A photo with no
            // readable text is a 422, never the demo invoice: the old
            // OCR_PROVIDER=sample path returned the fixed Core-Mark sample for
            // every photo, which is why real invoices "scanned" as sample data.
            extracted = await provider.extract(body.ocrText ?? body.imageBase64 ?? '');
          }
        }
      } catch (e) {
        res.status(422).json({
          error: e instanceof Error ? e.message : 'Could not read this invoice photo.',
        });
        return;
      }

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
      res.status(201).json({
        ...draft,
        lines,
        reconciliation: reconOverride
          ? {
              expectedTotalCents: reconOverride.expectedTotalCents,
              linesTotalCents: matched.reduce((s, l) => s + l.qty * l.unitCostCents, 0),
              expectedUnits: reconOverride.expectedUnits,
              linesUnits: matched.reduce((s, l) => s + l.qty, 0),
              matches:
                (reconOverride.expectedTotalCents === null ||
                  Math.abs(
                    matched.reduce((s, l) => s + l.qty * l.unitCostCents, 0) -
                      reconOverride.expectedTotalCents,
                  ) <= 200) &&
                (reconOverride.expectedUnits === null ||
                  matched.reduce((s, l) => s + l.qty, 0) === reconOverride.expectedUnits),
            }
          : reconcileInvoice(reconText, matched),
      });
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

const textSchema = z.object({
  storeId: z.string().uuid(),
  text: z.string().min(20).max(20000),
});

/**
 * POST /api/invoices/text — create a draft from invoice text the user
 * pasted (e.g. copied from the photo with iPhone Live Text, which reads
 * this kind of invoice far better than the in-app OCR). Same parser and
 * same draft-only flow as a photo scan.
 */
router.post('/text', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = textSchema.parse(req.body);
    const store = await pool.query(`SELECT id FROM stores WHERE id = $1`, [body.storeId]);
    if (store.rows.length === 0) {
      res.status(404).json({ error: 'Store not found' });
      return;
    }
    let extracted: Awaited<ReturnType<TextOcrProvider['extract']>>;
    try {
      extracted = await new TextOcrProvider().extract(body.text);
    } catch (e) {
      res.status(422).json({
        error: e instanceof Error ? e.message : 'Could not read any invoice lines from that text.',
      });
      return;
    }
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
          JSON.stringify({ ...extracted, source: 'pasted-text' }),
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
    const { rows: lines } = await pool.query(
      `SELECT id, product_id, name, barcode, qty, unit_cost_cents, status, confirmed
         FROM invoice_lines WHERE invoice_scan_id = $1 ORDER BY created_at`,
      [draft.id],
    );
    res.status(201).json({
      ...draft,
      lines,
      reconciliation: reconcileInvoice(body.text, matched),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid pasted-text request', details: err.issues });
      return;
    }
    next(err);
  }
});

const updateLineSchema = z.object({
  qty: z.number().int().min(1).optional(),
  unitCostCents: z.number().int().min(0).optional(),
});

/**
 * PATCH /api/invoices/:id/lines/:lineId — correct a draft line's qty/cost
 * before confirming. The UI lets the user edit qty/cost in the draft
 * table; without this endpoint those edits were silently ignored and the
 * original OCR values were posted. Only unconfirmed lines of a draft can
 * be edited.
 */
router.patch('/:id/lines/:lineId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.lineId)) {
      res.status(404).json({ error: 'Invoice line not found' });
      return;
    }
    const body = updateLineSchema.parse(req.body);
    if (body.qty === undefined && body.unitCostCents === undefined) {
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }
    const result = await withTransaction(async (client) => {
      const { rows: scans } = await client.query(
        `SELECT id, status FROM invoice_scans WHERE id = $1::uuid FOR UPDATE`,
        [req.params.id],
      );
      if (scans.length === 0) return { status: 404 as const, body: { error: 'Invoice not found' } };
      if (scans[0].status !== 'draft') {
        return { status: 400 as const, body: { error: `Invoice is ${scans[0].status}, not a draft` } };
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.qty !== undefined) {
        params.push(body.qty);
        sets.push(`qty = $${params.length}`);
      }
      if (body.unitCostCents !== undefined) {
        params.push(body.unitCostCents);
        sets.push(`unit_cost_cents = $${params.length}`);
      }
      params.push(req.params.id, req.params.lineId);
      const { rows } = await client.query(
        `UPDATE invoice_lines SET ${sets.join(', ')}
          WHERE invoice_scan_id = $${params.length - 1}::uuid
            AND id = $${params.length}::uuid
            AND confirmed = FALSE
          RETURNING id, product_id, name, barcode, qty, unit_cost_cents, status, confirmed`,
        params,
      );
      if (rows.length === 0) {
        return { status: 404 as const, body: { error: 'Invoice line not found or already confirmed' } };
      }
      return { status: 200 as const, body: rows[0] };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid line update', details: err.issues });
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
      if (!isUuid(req.params.id)) {
        res.status(404).json({ error: 'Invoice not found' });
        return;
      }
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
