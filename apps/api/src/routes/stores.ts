import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { priceFromCost } from '../pricing';
import { resolveStoreId } from '../db';

const createStoreSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  city: z.string().optional(),
  state: z.string().optional(),
  address: z.string().optional(),
  isHome: z.boolean().optional(),
  registerId: z.string().optional(),
});

const rolloutSchema = z.object({
  /** Explicit per-product margins. */
  margins: z
    .array(z.object({ productId: z.string().uuid(), marginPct: z.number().min(0).max(500) }))
    .optional(),
  /** Fallback margin applied to every product carried by the store. */
  defaultMarginPct: z.number().min(0).max(500).optional(),
});

export function storesRouter(pool: Pool): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, code, name, city, state, address, is_home, register_id, created_at
           FROM stores ORDER BY code`,
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = await resolveStoreId(pool, req.params.id);
      if (!storeId) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }
      const { rows } = await pool.query(
        `SELECT id, code, name, city, state, address, is_home, register_id, created_at
           FROM stores WHERE id = $1::uuid`,
        [storeId],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createStoreSchema.parse(req.body);
      const { rows } = await pool.query(
        `INSERT INTO stores (code, name, city, state, address, is_home, register_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          body.code,
          body.name,
          body.city ?? null,
          body.state ?? null,
          body.address ?? null,
          body.isHome ?? false,
          body.registerId ?? null,
        ],
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid store', details: err.issues });
        return;
      }
      next(err);
    }
  });

  /**
   * PATCH /api/stores/:id — rename / update a store's details (name, city,
   * state, address, is_home). Per-product margins are NOT set here; use
   * POST /api/stores/:id/rollout for margin repricing.
   */
  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patchSchema = z.object({
        name: z.string().min(1).optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        address: z.string().optional(),
        isHome: z.boolean().optional(),
      });
      const body = patchSchema.parse(req.body);
      const sets: string[] = [];
      const params: unknown[] = [];
      const map: Record<string, string> = {
        name: 'name',
        city: 'city',
        state: 'state',
        address: 'address',
        isHome: 'is_home',
      };
      for (const [key, col] of Object.entries(map)) {
        if (body[key as keyof typeof body] !== undefined) {
          params.push(body[key as keyof typeof body]);
          sets.push(`${col} = $${params.length}`);
        }
      }
      if (sets.length === 0) {
        res.status(400).json({ error: 'Nothing to update' });
        return;
      }
      const storeId = await resolveStoreId(pool, req.params.id);
      if (!storeId) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }
      params.push(storeId);
      const { rows } = await pool.query(
        `UPDATE stores SET ${sets.join(', ')} WHERE id = $${params.length}::uuid RETURNING *`,
        params,
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid store update', details: err.issues });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/stores/:id/rollout — set per-store margins and reprice from cost.
   * For each product: price_cents = priceFromCost(cost_cents, marginPct).
   * Upserts product_stores; existing on-hand is untouched (pricing is not stock).
   */
  router.post('/:id/rollout', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = rolloutSchema.parse(req.body);
      if (!body.margins && body.defaultMarginPct === undefined) {
        res.status(400).json({ error: 'Provide margins[] and/or defaultMarginPct' });
        return;
      }

      const storeId = await resolveStoreId(pool, req.params.id);
      if (!storeId) {
        res.status(404).json({ error: 'Store not found' });
        return;
      }

      const explicit = new Map(
        (body.margins ?? []).map((m) => [m.productId, m.marginPct]),
      );

      const { rows: products } = await pool.query(
        `SELECT id, cost_cents, price_cents FROM products`,
      );

      const updated: Array<{ productId: string; marginPct: number; priceCents: number }> = [];
      for (const product of products) {
        const marginPct = explicit.get(product.id) ?? body.defaultMarginPct;
        if (marginPct === undefined) continue;
        const priceCents = priceFromCost(product.cost_cents, marginPct);
        await pool.query(
          `INSERT INTO product_stores (store_id, product_id, margin_pct, price_cents)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (store_id, product_id)
           DO UPDATE SET margin_pct = EXCLUDED.margin_pct,
                         price_cents = EXCLUDED.price_cents,
                         updated_at = now()`,
          [storeId, product.id, marginPct, priceCents],
        );
        updated.push({ productId: product.id, marginPct, priceCents });
      }

      res.json({ storeId, updatedCount: updated.length, updated });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid rollout', details: err.issues });
        return;
      }
      next(err);
    }
  });

  return router;
}
