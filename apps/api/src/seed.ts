/**
 * seed.ts — seeds the 4 Michigan stores and the 12 demo SKUs from the
 * prototype, then posts opening 'receive' movements to par at the home
 * store (STORE-001, Auburn Hills) totalling 492 units.
 *
 * Idempotent: re-running it changes nothing (ON CONFLICT DO NOTHING, and
 * opening receives are posted only if STORE-001 has no movements yet).
 *
 * Run:  npm run seed   (requires DATABASE_URL; run db:migrate first)
 */
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface SeedProduct {
  barcode: string;
  name: string;
  category: string;
  /** Unit cost, cents. */
  costCents: number;
  /** Shelf price, cents. */
  priceCents: number;
  /** Par (reorder-to) level at the home store. Sums to 492 across all SKUs. */
  parQty: number;
}

// NOTE: Snickers 040000001017 and Pepsi 012000000927 have INVALID UPC
// check digits (the correct check digits would be 0 and 8). They are kept
// exactly as-is on purpose — the prototype's demo SKUs and the simulated
// Commander price book carry the same numbers, and silently "fixing" them
// would break barcode matching everywhere. Do not change these UPCs.
const PRODUCTS: SeedProduct[] = [
  { barcode: '085239010202', name: 'Bottled Water 16.9oz', category: 'Beverage', costCents: 45, priceCents: 149, parQty: 60 },
  { barcode: '049000050103', name: 'Coca-Cola 20oz', category: 'Beverage', costCents: 110, priceCents: 199, parQty: 55 },
  { barcode: '052000032137', name: 'Gatorade Cool Blue 20oz', category: 'Beverage', costCents: 120, priceCents: 219, parQty: 45 },
  { barcode: '070847001031', name: 'Monster Energy 16oz', category: 'Beverage', costCents: 165, priceCents: 299, parQty: 40 },
  { barcode: '070738500112', name: 'Milk Whole Gallon', category: 'Dairy', costCents: 320, priceCents: 429, parQty: 25 },
  { barcode: '028400064834', name: "Lay's Classic 2.625oz", category: 'Snack', costCents: 135, priceCents: 249, parQty: 40 },
  { barcode: '028400090516', name: 'Doritos Nacho Cheese 2.75oz', category: 'Snack', costCents: 135, priceCents: 249, parQty: 40 },
  { barcode: '040000001017', name: 'Snickers Bar 1.86oz', category: 'Snack', costCents: 95, priceCents: 189, parQty: 45 },
  { barcode: '034000000106', name: "Reese's Peanut Butter Cups 1.5oz", category: 'Snack', costCents: 95, priceCents: 189, parQty: 40 },
  { barcode: '012000000927', name: 'Pepsi 20oz', category: 'Beverage', costCents: 105, priceCents: 199, parQty: 50 },
  { barcode: '041220110202', name: 'Beef Jerky 3oz', category: 'Snack', costCents: 350, priceCents: 599, parQty: 25 },
  { barcode: '028100101010', name: 'Marlboro Red Pack', category: 'Tobacco', costCents: 750, priceCents: 999, parQty: 27 },
];

const STORES = [
  { code: 'STORE-001', name: 'Home Store', city: 'Auburn Hills', state: 'MI', isHome: true },
  { code: 'STORE-002', name: 'Detroit Store', city: 'Detroit', state: 'MI', isHome: false },
  { code: 'STORE-003', name: 'Grand Rapids Store', city: 'Grand Rapids', state: 'MI', isHome: false },
  { code: 'STORE-004', name: 'Traverse City Store', city: 'Traverse City', state: 'MI', isHome: false },
];

/** Target margin used when repricing from cost (see product_stores). */
const DEFAULT_MARGIN_PCT = 30;

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const storeIds = new Map<string, string>();
    for (const store of STORES) {
      const { rows } = await client.query(
        `INSERT INTO stores (code, name, city, state, is_home)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [store.code, store.name, store.city, store.state, store.isHome],
      );
      storeIds.set(store.code, rows[0].id);
    }

    const productIds = new Map<string, string>();
    for (const product of PRODUCTS) {
      const { rows } = await client.query(
        `INSERT INTO products (barcode, name, category, cost_cents, price_cents)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (barcode) DO UPDATE
           SET name = EXCLUDED.name, cost_cents = EXCLUDED.cost_cents,
               price_cents = EXCLUDED.price_cents
         RETURNING id`,
        [product.barcode, product.name, product.category, product.costCents, product.priceCents],
      );
      productIds.set(product.barcode, rows[0].id);
    }

    // Stock every product at every store. Par lives only at the home store;
    // the other stores start at par 0 (stocked, but no reorder target yet).
    for (const store of STORES) {
      const storeId = storeIds.get(store.code);
      if (!storeId) continue;
      for (const product of PRODUCTS) {
        const productId = productIds.get(product.barcode);
        if (!productId) continue;
        await client.query(
          `INSERT INTO product_stores (store_id, product_id, margin_pct, price_cents, par_qty)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (store_id, product_id) DO NOTHING`,
          [
            storeId,
            productId,
            DEFAULT_MARGIN_PCT,
            product.priceCents,
            store.code === 'STORE-001' ? product.parQty : 0,
          ],
        );
      }
    }

    // Opening receives to par at the home store — only on a fresh ledger.
    const homeId = storeIds.get('STORE-001');
    if (!homeId) throw new Error('STORE-001 was not created');
    const { rows: existing } = await client.query(
      `SELECT COUNT(*)::INTEGER AS n FROM movements WHERE store_id = $1`,
      [homeId],
    );
    if (existing[0].n === 0) {
      let total = 0;
      for (const product of PRODUCTS) {
        const productId = productIds.get(product.barcode);
        if (!productId) continue;
        await client.query(
          `INSERT INTO movements (store_id, product_id, type, qty_delta, cost_cents, note)
           VALUES ($1, $2, 'receive', $3, $4, 'Opening stock — seeded to par')`,
          [homeId, productId, product.parQty, product.costCents],
        );
        total += product.parQty;
      }
      // eslint-disable-next-line no-console
      console.log(`[seed] opening receives posted at STORE-001: ${total} units`);
    } else {
      // eslint-disable-next-line no-console
      console.log('[seed] STORE-001 already has movements — opening receives skipped');
    }

    await client.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log(
      `[seed] done: ${STORES.length} stores, ${PRODUCTS.length} products, ` +
        `par total ${PRODUCTS.reduce((s, p) => s + p.parQty, 0)} units`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed', err);
  process.exit(1);
});
