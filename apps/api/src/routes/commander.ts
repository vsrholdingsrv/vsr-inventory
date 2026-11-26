import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  CommanderTransaction,
  importPriceBook,
  ingestVerifoneTransaction,
  SimulatedCommanderConnector,
} from '../commander';
import { withTransaction } from '../db';

const transactionSchema = z.object({
  transactionId: z.string().min(1),
  storeId: z.string().uuid(),
  registerId: z.string().optional(),
  lines: z
    .array(
      z.object({
        upc: z.string().min(1),
        qty: z.number().int().positive(),
        priceCents: z.number().int().min(0),
        costCents: z.number().int().min(0).optional(),
      }),
    )
    .min(1),
  totalCents: z.number().int().min(0),
  occurredAt: z.string().optional(),
});

const importSchema = z.object({
  /** Store to stock the new products at (product_stores rows). Optional. */
  storeId: z.string().uuid().optional(),
});

export function commanderRouter(pool: Pool): Router {
  const router = Router();
  const connector = new SimulatedCommanderConnector();

  // GET /api/commander/price-book — current Commander price book (SIMULATED).
  router.get('/price-book', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await connector.pullPriceBook();
      res.json({ source: 'commander-simulated', count: items.length, items });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/commander/price-book/import — Commander Pull, add-new-only.
   * New UPCs become products; duplicates and inactive items are skipped,
   * never updated. Returns { added, updated: 0, skipped }.
   */
  router.post('/price-book/import', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = importSchema.parse(req.body);
      const items = await connector.pullPriceBook();
      const { rows: catalog } = await pool.query(
        `SELECT barcode FROM products`,
      );
      const result = importPriceBook(items, catalog);

      const addedIds: string[] = [];
      await withTransaction(async (client) => {
        for (const item of result.added) {
          const { rows } = await client.query(
            `INSERT INTO products (barcode, name, category, cost_cents, price_cents)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (barcode) DO NOTHING RETURNING id`,
            [item.upc, item.name, item.category, item.costCents, item.priceCents],
          );
          if (rows[0]) {
            addedIds.push(rows[0].id);
            if (body.storeId) {
              await client.query(
                `INSERT INTO product_stores (store_id, product_id, margin_pct, price_cents)
                 VALUES ($1, $2, 30, $3)
                 ON CONFLICT (store_id, product_id) DO NOTHING`,
                [body.storeId, rows[0].id, item.priceCents],
              );
            }
          }
        }
        await client.query(
          `INSERT INTO price_book_imports
             (store_id, source, added_count, skipped_count, detail)
           VALUES ($1, 'commander-simulated', $2, $3, $4)`,
          [
            body.storeId ?? null,
            result.added.length,
            result.skipped.length,
            JSON.stringify({
              skipped: result.skipped.map((s) => ({
                upc: s.item.upc,
                classification: s.classification,
                reason: s.reason,
              })),
            }),
          ],
        );
      });

      res.json({
        added: result.added,
        addedCount: result.added.length,
        addedIds,
        updated: result.updated,
        skipped: result.skipped.map((s) => ({
          upc: s.item.upc,
          name: s.item.name,
          classification: s.classification,
          reason: s.reason,
        })),
        skippedCount: result.skipped.length,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid import request', details: err.issues });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/commander/transactions — ingest one Commander sale.
   * De-dupes on transaction_id (unique in pos_transactions): a replay
   * returns { accepted: false, duplicate: true } and posts nothing.
   * Lines exceeding on-hand are blocked as insufficient_stock and recorded
   * in pos_events; stock never goes negative.
   */
  router.post('/transactions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = transactionSchema.parse(req.body);
      const tx: CommanderTransaction = {
        transactionId: body.transactionId,
        storeId: body.storeId,
        registerId: body.registerId ?? '',
        lines: body.lines,
        totalCents: body.totalCents,
        occurredAt: body.occurredAt,
      };

      const result = await withTransaction(async (client) => {
        // De-dupe first: the UNIQUE constraint is the backstop, the
        // ON CONFLICT ... DO NOTHING keeps the replay a no-op, not an error.
        const { rows: inserted } = await client.query(
          `INSERT INTO pos_transactions
             (transaction_id, store_id, register_id, total_cents, source, occurred_at)
           VALUES ($1, $2, $3, $4, 'commander-simulated', $5)
           ON CONFLICT (transaction_id) DO NOTHING RETURNING id`,
          [
            tx.transactionId,
            tx.storeId,
            tx.registerId || null,
            tx.totalCents,
            tx.occurredAt ?? null,
          ],
        );
        if (inserted.length === 0) {
          await client.query(
            `INSERT INTO pos_events (transaction_id, store_id, event_type, detail)
             VALUES ($1, $2, 'duplicate', $3)`,
            [tx.transactionId, tx.storeId, JSON.stringify({ reason: 'transaction_id already ingested' })],
          );
          return {
            transactionId: tx.transactionId,
            accepted: false,
            duplicate: true,
            postedLines: [],
            unmatchedLines: [],
          };
        }

        // Catalog + on-hand for this store, by UPC.
        const { rows: stocked } = await client.query(
          `SELECT p.id AS product_id, p.barcode, p.cost_cents,
                  COALESCE(SUM(m.qty_delta), 0)::INTEGER AS on_hand
             FROM products p
             LEFT JOIN movements m
               ON m.product_id = p.id AND m.store_id = $1
            GROUP BY p.id`,
          [tx.storeId],
        );
        const productByUpc = new Map(
          stocked.map((r: { barcode: string; product_id: string; cost_cents: number }) => [
            r.barcode,
            { productId: r.product_id, costCents: r.cost_cents },
          ]),
        );
        const onHandByUpc = new Map<string, number>();
        for (const r of stocked as Array<{ barcode: string; on_hand: number }>) {
          // Only UPCs stocked at this store count as known; a UPC with no
          // product_stores row and no movements is treated as unmatched.
          onHandByUpc.set(r.barcode, r.on_hand);
        }
        // Restrict "known" to products actually carried by this store.
        const { rows: carried } = await client.query(
          `SELECT p.barcode FROM product_stores ps
            JOIN products p ON p.id = ps.product_id
           WHERE ps.store_id = $1`,
          [tx.storeId],
        );
        const carriedUpcs = new Set(carried.map((r: { barcode: string }) => r.barcode));
        for (const upc of [...onHandByUpc.keys()]) {
          if (!carriedUpcs.has(upc)) onHandByUpc.delete(upc);
        }

        const ingest = ingestVerifoneTransaction(tx, {
          onHandByUpc,
          seenTransactionIds: new Set<string>(),
        });

        for (const line of ingest.postedLines) {
          const product = productByUpc.get(line.upc);
          if (!product) continue; // cannot happen: posted implies known UPC
          await client.query(
            `INSERT INTO movements (store_id, product_id, type, qty_delta, cost_cents, note)
             VALUES ($1, $2, 'sale', $3, $4, $5)`,
            [tx.storeId, product.productId, -line.qty, product.costCents, `POS ${tx.transactionId}`],
          );
        }
        for (const unmatched of ingest.unmatchedLines) {
          const product = productByUpc.get(unmatched.line.upc);
          await client.query(
            `INSERT INTO pos_events
               (transaction_id, store_id, product_id, upc, event_type, detail)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              tx.transactionId,
              tx.storeId,
              product?.productId ?? null,
              unmatched.line.upc,
              unmatched.reason,
              JSON.stringify({ detail: unmatched.detail, qty: unmatched.line.qty }),
            ],
          );
        }

        return ingest;
      });

      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid transaction', details: err.issues });
        return;
      }
      next(err);
    }
  });

  return router;
}
