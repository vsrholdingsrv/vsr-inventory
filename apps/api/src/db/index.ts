import { Pool, PoolClient } from 'pg';

/**
 * Single shared pg Pool. DATABASE_URL is required in every environment
 * except the pure-logic unit tests, which never import this module.
 */
const connectionString = process.env.DATABASE_URL;

export const pool: Pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  // A pool error must never crash the process silently; log and keep serving.
  // eslint-disable-next-line no-console
  console.error('[db] idle pool error', err);
});

export function requireDatabaseUrl(): string {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (see apps/api/.env.example)');
  }
  return connectionString;
}

/** Run work inside a single transaction; rolls back on any error. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** On-hand for one (store, product), computed from the ledger — never stored. */
export async function getOnHand(
  client: Pool | PoolClient,
  storeId: string,
  productId: string,
): Promise<number> {
  const { rows } = await client.query<{ on_hand: string }>(
    `SELECT COALESCE(SUM(qty_delta), 0) AS on_hand
       FROM movements
      WHERE store_id = $1 AND product_id = $2`,
    [storeId, productId],
  );
  return Number(rows[0]?.on_hand ?? 0);
}
