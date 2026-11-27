import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { resolveStoreId } from '../db';

/**
 * GET /api/dashboard/summary — one call for the dashboard home screen.
 * All stock figures derive from the ledger via store_inventory; on-hand is
 * never read from a stored column.
 */
export function dashboardRouter(pool: Pool): Router {
  const router = Router();

  router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawStoreId =
        typeof req.query.storeId === 'string' ? req.query.storeId : null;
      // A store code (STORE-001) is accepted, not just a UUID; an unknown
      // store is a 404, and a raw non-UUID value never reaches Postgres
      // (it would 500 with 22P02 on `store_id = $1`).
      const storeId = rawStoreId ? await resolveStoreId(pool, rawStoreId) : null;
      if (rawStoreId && !storeId) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }

      const storeFilter = storeId ? 'WHERE store_id = $1::uuid' : '';
      const params = storeId ? [storeId] : [];

      const [{ rows: totals }] = await Promise.all([
        pool.query(
          `SELECT
             ${storeId ? '1' : '(SELECT COUNT(*) FROM stores)'}::INTEGER AS stores,
             COUNT(*)::INTEGER AS stocked_products,
             COALESCE(SUM(on_hand), 0)::INTEGER AS total_units,
             COALESCE(SUM(on_hand * cost_cents), 0)::INTEGER AS inventory_value_cost_cents,
             COALESCE(SUM(on_hand * price_cents), 0)::INTEGER AS inventory_value_retail_cents,
             COUNT(*) FILTER (WHERE on_hand < par_qty AND par_qty > 0)::INTEGER AS low_stock_products,
             COUNT(*) FILTER (WHERE on_hand = 0 AND par_qty > 0)::INTEGER AS out_of_stock_products
           FROM store_inventory ${storeFilter}`,
          params,
        ),
      ]);

      const { rows: recentMovements } = await pool.query(
        `SELECT m.id, m.store_id, m.product_id, p.name AS product_name, p.barcode,
                m.type, m.qty_delta, m.cost_cents, m.note, m.created_at
           FROM movements m JOIN products p ON p.id = m.product_id
          ${storeId ? 'WHERE m.store_id = $1::uuid' : ''}
          ORDER BY m.created_at DESC LIMIT 10`,
        params,
      );

      const { rows: unmatched } = await pool.query(
        `SELECT COUNT(*)::INTEGER AS unmatched_events,
                COUNT(*) FILTER (WHERE event_type = 'insufficient_stock')::INTEGER AS insufficient_stock_events
           FROM pos_events ${storeFilter}`,
        params,
      );

      const { rows: lowStock } = await pool.query(
        `SELECT store_id, product_id, barcode, name, on_hand, par_qty
           FROM store_inventory
          ${storeId ? 'WHERE store_id = $1::uuid AND' : 'WHERE'} on_hand < par_qty AND par_qty > 0
          ORDER BY (par_qty - on_hand) DESC LIMIT 20`,
        params,
      );

      res.json({
        ...(totals[0] ?? {
          stores: 0,
          stocked_products: 0,
          total_units: 0,
          inventory_value_cost_cents: 0,
          inventory_value_retail_cents: 0,
          low_stock_products: 0,
          out_of_stock_products: 0,
        }),
        storeId,
        unmatchedEvents: unmatched[0]?.unmatched_events ?? 0,
        insufficientStockEvents: unmatched[0]?.insufficient_stock_events ?? 0,
        lowStock,
        recentMovements,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
