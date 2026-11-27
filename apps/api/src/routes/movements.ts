import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  buildMovement,
  InsufficientStockError,
  MovementType,
  recordCount,
  validateMovement,
} from '../ledger';
import { getOnHand, isPgForeignKeyViolation, isUuid, withTransaction } from '../db';

const MOVEMENT_TYPES: MovementType[] = [
  'receive',
  'sale',
  'waste',
  'damage',
  'expired',
  'shrinkage',
  'transfer-out',
  'return',
  'count-correction',
];

const createMovementSchema = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
  type: z.enum(MOVEMENT_TYPES as [MovementType, ...MovementType[]]),
  /**
   * Unsigned qty for receive/return/outgoing types; signed variance
   * (counted - expected) for count-correction.
   */
  qty: z.number().int().refine((q) => q !== 0, 'qty must not be zero'),
  costCents: z.number().int().min(0).optional(),
  note: z.string().optional(),
});

const cycleCountSchema = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
  /** Defaults to current on-hand when omitted (blind count vs the ledger). */
  expectedQty: z.number().int().min(0).optional(),
  countedQty: z.number().int().min(0),
  countedBy: z.string().optional(),
});

export function movementsRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/movements?storeId=&productId=&limit=
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(
        Math.max(Number(req.query.limit ?? 50) || 50, 1),
        500,
      );
      const conditions: string[] = [];
      const params: unknown[] = [];
      // Malformed UUIDs are a 400 here: Postgres would 500 (22P02) on
      // `store_id = $1` with a non-UUID string.
      if (typeof req.query.storeId === 'string') {
        if (!isUuid(req.query.storeId)) {
          res.status(400).json({ error: 'Invalid storeId' });
          return;
        }
        params.push(req.query.storeId);
        conditions.push(`store_id = $${params.length}::uuid`);
      }
      if (typeof req.query.productId === 'string') {
        if (!isUuid(req.query.productId)) {
          res.status(400).json({ error: 'Invalid productId' });
          return;
        }
        params.push(req.query.productId);
        conditions.push(`product_id = $${params.length}::uuid`);
      }
      params.push(limit);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await pool.query(
        `SELECT id, store_id, product_id, type, qty_delta, cost_cents, note, created_at
           FROM movements ${where}
          ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/movements — append one ledger movement (zero-stock floor enforced).
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createMovementSchema.parse(req.body);
      const movement = buildMovement({
        storeId: body.storeId,
        productId: body.productId,
        type: body.type,
        qty: body.qty,
        costCents: body.costCents,
        note: body.note,
      });

      const result = await withTransaction(async (client) => {
        // Referenced store/product must exist: otherwise the INSERT fails
        // on the foreign key and surfaces as a 500.
        const { rows: refs } = await client.query(
          `SELECT (SELECT COUNT(*) FROM stores WHERE id = $1::uuid) AS stores,
                  (SELECT COUNT(*) FROM products WHERE id = $2::uuid) AS products`,
          [body.storeId, body.productId],
        );
        if (Number(refs[0]?.stores ?? 0) === 0) {
          throw Object.assign(new Error('Store not found'), { status: 404 });
        }
        if (Number(refs[0]?.products ?? 0) === 0) {
          throw Object.assign(new Error('Product not found'), { status: 404 });
        }
        const onHand = await getOnHand(client, body.storeId, body.productId);
        const newOnHand = validateMovement(movement, onHand); // throws InsufficientStockError
        const { rows } = await client.query(
          `INSERT INTO movements (store_id, product_id, type, qty_delta, cost_cents, note)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            movement.store_id,
            movement.product_id,
            movement.type,
            movement.qty_delta,
            movement.cost_cents,
            movement.note,
          ],
        );
        return { movement: rows[0], onHand: newOnHand };
      });

      res.status(201).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid movement', details: err.issues });
        return;
      }
      if (err instanceof InsufficientStockError) {
        res.status(409).json({ error: err.message, onHand: err.onHand });
        return;
      }
      if (err instanceof Error && (err as { status?: unknown }).status === 404) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof Error) {
        if (isPgForeignKeyViolation(err)) {
          res.status(404).json({ error: 'Store or product not found' });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/movements/cycle-counts — blind count + correction in one call.
   * Records the cycle_counts row; posts a 'count-correction' movement only
   * when the variance is non-zero. Stock is set to the counted value.
   */
  router.post('/cycle-counts', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = cycleCountSchema.parse(req.body);
      const result = await withTransaction(async (client) => {
        const { rows: refs } = await client.query(
          `SELECT (SELECT COUNT(*) FROM stores WHERE id = $1::uuid) AS stores,
                  (SELECT COUNT(*) FROM products WHERE id = $2::uuid) AS products`,
          [body.storeId, body.productId],
        );
        if (Number(refs[0]?.stores ?? 0) === 0) {
          throw Object.assign(new Error('Store not found'), { status: 404 });
        }
        if (Number(refs[0]?.products ?? 0) === 0) {
          throw Object.assign(new Error('Product not found'), { status: 404 });
        }
        const onHand = await getOnHand(client, body.storeId, body.productId);
        const expectedQty = body.expectedQty ?? onHand;
        const count = recordCount({ expectedQty, countedQty: body.countedQty });

        const { rows: countRows } = await client.query(
          `INSERT INTO cycle_counts (store_id, product_id, expected_qty, counted_qty, counted_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [body.storeId, body.productId, expectedQty, body.countedQty, body.countedBy ?? null],
        );

        let movementRow = null;
        if (count.postsMovement) {
          const movement = buildMovement({
            storeId: body.storeId,
            productId: body.productId,
            type: 'count-correction',
            qty: count.qtyDelta,
            note: `Cycle count: expected ${expectedQty}, counted ${body.countedQty}`,
          });
          validateMovement(movement, onHand);
          const { rows } = await client.query(
            `INSERT INTO movements (store_id, product_id, type, qty_delta, cost_cents, note)
             VALUES ($1, $2, $3, $4, NULL, $5) RETURNING *`,
            [movement.store_id, movement.product_id, movement.type, movement.qty_delta, movement.note],
          );
          movementRow = rows[0];
        }

        return {
          cycleCount: countRows[0],
          variance: count.variance,
          movement: movementRow,
          onHand: onHand + count.qtyDelta,
        };
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid cycle count', details: err.issues });
        return;
      }
      if (err instanceof InsufficientStockError) {
        res.status(409).json({ error: err.message, onHand: err.onHand });
        return;
      }
      if (err instanceof Error && (err as { status?: unknown }).status === 404) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof Error) {
        if (isPgForeignKeyViolation(err)) {
          res.status(404).json({ error: 'Store or product not found' });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
