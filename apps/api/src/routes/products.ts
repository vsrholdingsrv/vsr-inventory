import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  isPgUniqueViolation,
  isUuid,
  resolveStoreId,
  withTransaction,
} from '../db';

const createProductSchema = z.object({
  barcode: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional(),
  costCents: z.number().int().min(0),
  priceCents: z.number().int().min(0),
});

export function productsRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/products — catalog with per-store on-hand when ?storeId= given.
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawStoreId =
        typeof req.query.storeId === 'string' ? req.query.storeId : null;
      // A store code (STORE-001) is accepted here, not just a UUID id;
      // anything else that resolves to no store is a 404, never a 500.
      const storeId = rawStoreId ? await resolveStoreId(pool, rawStoreId) : null;
      if (rawStoreId && !storeId) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }
      if (storeId) {
        const { rows } = await pool.query(
          `SELECT product_id AS id, barcode, name, category, cost_cents,
                  price_cents, margin_pct, par_qty, on_hand
             FROM store_inventory
            WHERE store_id = $1::uuid
            ORDER BY name`,
          [storeId],
        );
        res.json(rows);
        return;
      }
      const { rows } = await pool.query(
        `SELECT id, barcode, name, category, cost_cents, price_cents
             FROM products ORDER BY name`,
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/products/:id — one product + on-hand across all stores.
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // A malformed id is "not found", not a 500: Postgres rejects a
      // non-UUID string in `p.id = $1` with 22P02.
      if (!isUuid(req.params.id)) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }
      const { rows } = await pool.query(
        `SELECT p.id, p.barcode, p.name, p.category, p.cost_cents, p.price_cents,
                COALESCE(SUM(oh.on_hand), 0)::INTEGER AS on_hand_total
           FROM products p
           LEFT JOIN store_product_on_hand oh ON oh.product_id = p.id
          WHERE p.id = $1::uuid
          GROUP BY p.id`,
        [req.params.id],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/products — add a product to the catalog.
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createProductSchema.parse(req.body);
      const { rows } = await pool.query(
        `INSERT INTO products (barcode, name, category, cost_cents, price_cents)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [body.barcode, body.name, body.category ?? null, body.costCents, body.priceCents],
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid product', details: err.issues });
        return;
      }
      if (isPgUniqueViolation(err)) {
        res.status(409).json({ error: `Barcode ${req.body?.barcode} already exists` });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/products/restock-all — one-click demo refill: for the given
   * store (or the first store), receive every product below par up to par.
   * Each refill is an append-only 'receive' movement in the ledger.
   */
  router.post('/restock-all', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requested = typeof req.body?.storeId === 'string' ? req.body.storeId : null;
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
      const { rows: below } = await pool.query(
        `SELECT product_id, on_hand, par_qty, cost_cents
           FROM store_inventory WHERE store_id = $1 AND on_hand < par_qty`,
        [storeId],
      );
      await withTransaction(async (client) => {
        for (const row of below) {
          const qty = row.par_qty - row.on_hand;
          await client.query(
            `INSERT INTO movements (store_id, product_id, type, qty_delta, cost_cents, note)
             VALUES ($1, $2, 'receive', $3, $4, 'Restock to par — one-click demo refill')`,
            [storeId, row.product_id, qty, row.cost_cents],
          );
        }
      });
      const { rows } = await pool.query(
        `SELECT product_id AS id, barcode, name, category, cost_cents,
                price_cents, margin_pct, par_qty, on_hand
           FROM store_inventory WHERE store_id = $1 ORDER BY name`,
        [storeId],
      );
      res.json({ storeId, restockedCount: below.length, products: rows });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
