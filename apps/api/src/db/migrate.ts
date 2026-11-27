import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

/**
 * Apply schema.sql on startup so a fresh Render database gets its tables
 * without needing a shell, psql, or a manual migrate step.
 *
 * schema.sql is idempotent (CREATE TABLE IF NOT EXISTS everywhere), so
 * running it on every boot is safe. The file is NOT copied into dist/ by
 * tsc, so we look for it in the source tree first (present on Render,
 * where the repo is checked out) and in dist/ as a fallback.
 */
export async function migrateDatabase(pool: Pool): Promise<void> {
  const candidates = [
    path.join(process.cwd(), 'src/db/schema.sql'),
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '../db/schema.sql'),
    path.join(process.cwd(), 'dist/db/schema.sql'),
  ];
  const schemaPath = candidates.find((p) => fs.existsSync(p));
  if (!schemaPath) {
    throw new Error(
      `schema.sql not found (tried: ${candidates.join(', ')})`,
    );
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  // eslint-disable-next-line no-console
  console.log(`[migrate] schema applied from ${schemaPath}`);
}
