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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value is a well-formed UUID string. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** True when the error is a Postgres unique-violation (code 23505). */
export function isPgUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}

/** True when the error is a Postgres foreign-key violation (code 23503). */
export function isPgForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23503'
  );
}

/**
 * Resolve a store by UUID id or by code (e.g. 'STORE-001') to its UUID id.
 * The old `WHERE id = $1 OR code = $1` pattern is broken in Postgres:
 * one parameter compared to both a uuid column and a text column makes
 * Postgres pick text, and `text = uuid` errors with 42883
 * ("operator does not exist: text = uuid"). Querying by one column at a
 * time, with an explicit ::uuid cast for ids, avoids that entirely.
 */
export async function resolveStoreId(
  pool: Pool,
  idOrCode: string,
): Promise<string | null> {
  const rows = UUID_RE.test(idOrCode)
    ? (
        await pool.query<{ id: string }>(
          `SELECT id FROM stores WHERE id = $1::uuid`,
          [idOrCode],
        )
      ).rows
    : (
        await pool.query<{ id: string }>(
          `SELECT id FROM stores WHERE code = $1`,
          [idOrCode],
        )
      ).rows;
  return rows[0]?.id ?? null;
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
