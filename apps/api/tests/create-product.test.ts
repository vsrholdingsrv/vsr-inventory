/**
 * POST /api/products regression tests (0.1.4): adding a product must stock
 * it at a store in the same call. Before 0.1.4 the route only inserted the
 * catalog row, so a newly added product was invisible to Scan (which looks
 * products up per-store) and could never be sold — the user scanned
 * 082184000342, got "No product with barcode … in the catalog", and had
 * nowhere in the app to add it.
 */
import express, { type Express } from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { productsRouter } from '../src/routes/products';

const STORE_ID = '4be72c43-e888-4845-8fa0-38fd718312cc';

describe('POST /api/products stocks the product at a store (0.1.4)', () => {
  let app: Express;
  let server: ReturnType<Express['listen']>;
  let base = '';
  const seen: string[] = [];

  beforeAll(async () => {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        seen.push(sql);
        if (sql.includes('FROM stores ORDER BY code LIMIT 1')) {
          return { rows: [{ id: STORE_ID }] };
        }
        if (sql.includes('INSERT INTO products')) {
          return {
            rows: [
              {
                id: '08218400-0342-4000-8000-000000000001',
                barcode: '082184000342',
                name: 'Test Product',
                category: 'Snacks',
                cost_cents: 150,
                price_cents: 195,
              },
            ],
          };
        }
        if (sql.includes('INSERT INTO product_stores')) {
          return { rows: [] };
        }
        if (sql.includes('FROM store_inventory')) {
          return {
            rows: [
              {
                id: '08218400-0342-4000-8000-000000000001',
                barcode: '082184000342',
                name: 'Test Product',
                category: 'Snacks',
                cost_cents: 150,
                price_cents: 195,
                margin_pct: '30.00',
                par_qty: 12,
                on_hand: 0,
              },
            ],
          };
        }
        return { rows: [] };
      },
      connect: async () => {
        throw new Error('fake pool has no client connections');
      },
    } as never;
    // withTransaction uses pool.connect(); stub it to run the fn directly.
    (pool as { connect: unknown }).connect = async () => ({
      query: (sql: string, params?: unknown[]) =>
        (pool as { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }).query(
          sql,
          params,
        ),
      release: () => {},
    });
    app = express();
    app.use(express.json());
    app.use('/api/products', productsRouter(pool));
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

  it('creates the product AND a product_stores row, and returns it stocked', async () => {
    const res = await fetch(`${base}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barcode: '082184000342',
        name: 'Test Product',
        category: 'Snacks',
        costCents: 150,
        marginPct: 30,
        parQty: 12,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      barcode: string;
      par_qty: number;
      on_hand: number;
    };
    expect(body.barcode).toBe('082184000342');
    expect(body.par_qty).toBe(12);
    expect(body.on_hand).toBe(0);
    expect(seen.some((s) => s.includes('INSERT INTO product_stores'))).toBe(true);
  });

  it('requires a price or a margin', async () => {
    const res = await fetch(`${base}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode: '000000000001', name: 'No Price', costCents: 100 }),
    });
    expect(res.status).toBe(400);
  });
});
