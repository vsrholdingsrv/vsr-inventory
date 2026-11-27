/**
 * routes.test.ts — regression tests for the 0.1.2 / 0.1.3 route bugs.
 *
 * These run against the real Express routers with a fake pg Pool, so they
 * exercise the SQL the routes actually send (no live database needed).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { isUuid, isPgUniqueViolation, isPgForeignKeyViolation, resolveStoreId } from '../src/db';
import { storesRouter } from '../src/routes/stores';
import { productsRouter } from '../src/routes/products';

const STORE_ID = '4be72c43-e888-4845-8fa0-38fd718312cc';
const PRODUCT_ID = '04900005-0103-4000-8000-000000000001';

interface FakeQuery {
  sql: string;
  params: unknown[];
}

/** Minimal fake Pool: records every query and answers from canned rows. */
function fakePool(handlers: Array<(q: FakeQuery) => { rows: unknown[] } | null>): {
  pool: Pool;
  seen: FakeQuery[];
} {
  const seen: FakeQuery[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const q = { sql, params };
      seen.push(q);
      for (const h of handlers) {
        const out = h(q);
        if (out) return out;
      }
      return { rows: [] };
    },
    connect: async () => {
      throw new Error('fake pool has no client connections');
    },
  } as unknown as Pool;
  return { pool, seen };
}

describe('isUuid / pg error helpers', () => {
  it('accepts real UUIDs and rejects store codes and junk', () => {
    expect(isUuid(STORE_ID)).toBe(true);
    expect(isUuid('STORE-001')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });

  it('recognises unique- and foreign-key violations by Postgres code', () => {
    expect(isPgUniqueViolation({ code: '23505' })).toBe(true);
    expect(isPgUniqueViolation({ code: '42883' })).toBe(false);
    expect(isPgUniqueViolation(new Error('boom'))).toBe(false);
    expect(isPgForeignKeyViolation({ code: '23503' })).toBe(true);
    expect(isPgForeignKeyViolation({ code: '23505' })).toBe(false);
  });
});

describe('resolveStoreId (0.1.2 regression: text = uuid, error 42883)', () => {
  it('looks a UUID up by id with an explicit ::uuid cast', async () => {
    const { pool, seen } = fakePool([
      (q) =>
        q.sql.includes('FROM stores WHERE id = $1::uuid')
          ? { rows: [{ id: STORE_ID }] }
          : null,
    ]);
    const id = await resolveStoreId(pool, STORE_ID);
    expect(id).toBe(STORE_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).not.toContain('OR code');
  });

  it('looks a code up by code only, never comparing text to the uuid column', async () => {
    const { pool, seen } = fakePool([
      (q) =>
        q.sql.includes('FROM stores WHERE code = $1')
          ? { rows: [{ id: STORE_ID }] }
          : null,
    ]);
    const id = await resolveStoreId(pool, 'STORE-001');
    expect(id).toBe(STORE_ID);
    expect(seen[0].sql).not.toContain('id =');
  });

  it('returns null for an unknown store instead of throwing', async () => {
    const { pool } = fakePool([]);
    await expect(resolveStoreId(pool, 'STORE-999')).resolves.toBeNull();
  });
});

describe('stores / products routes with a fake pool', () => {
  let app: Express;
  let server: ReturnType<Express['listen']>;
  let base = '';

  beforeAll(async () => {
    const { pool } = fakePool([
      // resolveStoreId by code
      (q) =>
        q.sql.includes('FROM stores WHERE code = $1')
          ? { rows: [{ id: STORE_ID }] }
          : null,
      // resolveStoreId by UUID
      (q) =>
        q.sql.includes('FROM stores WHERE id = $1::uuid')
          ? { rows: [{ id: STORE_ID }] }
          : null,
      // rollout: only products the store already carries
      (q) =>
        q.sql.includes('JOIN product_stores')
          ? {
              rows: [
                { id: PRODUCT_ID, cost_cents: 110, price_cents: 199 },
                { id: '04900005-0103-4000-8000-000000000002', cost_cents: 95, price_cents: 189 },
              ],
            }
          : null,
      // rollout upserts
      (q) =>
        q.sql.includes('INSERT INTO product_stores')
          ? { rows: [] }
          : null,
      // GET /api/products/:id with a real UUID
      (q) =>
        q.sql.includes('FROM products p') && q.sql.includes('on_hand_total')
          ? {
              rows: [
                {
                  id: PRODUCT_ID,
                  barcode: '049000050103',
                  name: 'Coca-Cola 20oz',
                  category: 'Beverage',
                  cost_cents: 110,
                  price_cents: 199,
                  on_hand_total: 48,
                },
              ],
            }
          : null,
      // POST /api/products duplicate barcode -> unique violation
      (q) => {
        if (q.sql.includes('INSERT INTO products')) {
          throw Object.assign(new Error('duplicate key value'), { code: '23505' });
        }
        return null;
      },
    ]);
    app = express();
    app.use(express.json());
    app.use('/api/stores', storesRouter(pool));
    app.use('/api/products', productsRouter(pool));
    // Central error handler mirroring src/index.ts (no stack leaks).
    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).json({ error: 'Internal server error' });
      },
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POST /api/stores/:id/rollout by UUID returns 200 (was 500, 42883)', async () => {
    const res = await fetch(`${base}/api/stores/${STORE_ID}/rollout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultMarginPct: 10 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { storeId: string; updatedCount: number };
    expect(body.storeId).toBe(STORE_ID);
    expect(body.updatedCount).toBe(2);
  });

  it('POST /api/stores/STORE-001/rollout by code also returns 200', async () => {
    const res = await fetch(`${base}/api/stores/STORE-001/rollout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultMarginPct: 10 }),
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/products/not-a-uuid returns 404, not 500', async () => {
    const res = await fetch(`${base}/api/products/not-a-uuid`);
    expect(res.status).toBe(404);
  });

  it('GET /api/products/:uuid returns the product', async () => {
    const res = await fetch(`${base}/api/products/${PRODUCT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { barcode: string };
    expect(body.barcode).toBe('049000050103');
  });

  it('POST /api/products with a duplicate barcode returns 409, not 500', async () => {
    const res = await fetch(`${base}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barcode: '049000050103',
        name: 'Coca-Cola 20oz',
        costCents: 110,
        priceCents: 199,
      }),
    });
    expect(res.status).toBe(409);
  });
});
