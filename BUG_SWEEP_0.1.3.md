# VSR Inventory — Bug Sweep 0.1.3

Date: 2026-11-26 (evening, after the 0.1.2 rollout-500 fix)
Scope: full audit of the standalone repo at `~/workspace/vsr-inventory`
(version 0.1.2 → **0.1.3**). No live Render / GitHub actions were taken,
no live database was touched, no zip was created. All work is in the repo
only; push + deploy is the next step (parent agent's call).

## Final verification

- `npm run typecheck` — **exit 0** (api, shared)
- `npm run build --workspace=apps/api` — **exit 0**
- `npm run build --workspace=apps/web` — **exit 0** (`tsc -b && vite build`)
- `npm run test --workspace=apps/api` — **53/53 pass, 5 files**
  (was 41/41 in 0.1.2; +12 new tests, see below)

## Bugs found and fixed

### B1 — Commander ingest let duplicate UPC lines oversell stock (HIGH)
- **File:** `apps/api/src/commander.ts` — `ingestVerifoneTransaction()`
- **Symptom:** each line was checked against the *starting* on-hand, so a
  transaction with two lines of 5× Coke against 8 on hand posted both
  (10 sold) and drove stock to −2. The zero-stock floor was bypassed on
  the Commander path (the `/api/commander/transactions` route posts
  whatever `ingestVerifoneTransaction` returns, with no second check).
- **Fix:** track remaining on-hand per UPC inside the transaction and
  decrement as lines post; the second line now reports
  `insufficient_stock` ("Only 3 on hand").
- **Tests:** 2 new tests in `apps/api/tests/commander.test.ts`
  (5+5 against 8 posts only 5; 3+2 against 5 posts both).

### B2 — Rollout repriced (and silently stocked) products a store doesn't carry (HIGH)
- **File:** `apps/api/src/routes/stores.ts` — `POST /api/stores/:id/rollout`
- **Symptom:** the rollout read *all* products from the catalog and
  upserted a `product_stores` row for every one, so saving a rollout at
  Detroit silently stocked all 28 catalog products there (par 0) and
  inflated the dashboard's stocked-product / low-stock counts.
- **Fix:** the rollout now selects only products already in
  `product_stores` for that store (`JOIN product_stores … AND ps.store_id = $1::uuid`).
- **Tests:** rollout tests in `apps/api/tests/routes.test.ts` assert the
  query joins `product_stores` (fake pool only answers carried products).

### B3 — Non-UUID ids in path params returned 500 instead of 404 (MEDIUM)
- **Files:** `apps/api/src/routes/products.ts` (`GET /:id`),
  `apps/api/src/routes/invoices.ts` (`GET /:id`, `POST /:id/confirm`)
- **Symptom:** `GET /api/products/not-a-uuid` sent the raw string to
  `WHERE p.id = $1`; Postgres rejects it with 22P02 and the central
  handler returned 500.
- **Fix:** new `isUuid()` helper in `apps/api/src/db/index.ts`; routes
  return 404 for malformed ids before touching the database, and use
  `$1::uuid` casts.
- **Tests:** `routes.test.ts` — `GET /api/products/not-a-uuid` → 404.

### B4 — Raw storeId query params could 500 (MEDIUM)
- **Files:** `apps/api/src/routes/products.ts` (`GET /?storeId=`),
  `apps/api/src/routes/dashboard.ts` (`GET /summary?storeId=`),
  `apps/api/src/routes/invoices.ts` (`GET /?storeId=`),
  `apps/api/src/routes/movements.ts` (`GET /?storeId=&productId=`)
- **Symptom:** a store *code* (`STORE-001`) or junk in `?storeId=` was
  passed straight to `store_id = $1` — 22P02/42883 → 500. Only UUIDs
  happened to work.
- **Fix:** query params are resolved through the 0.1.2 `resolveStoreId()`
  (code or UUID); unknown stores return 404, never 500. Movements
  validates UUID params and returns 400 for malformed ones.

### B5 — Duplicate barcode / store code returned 500 instead of 409 (MEDIUM)
- **Files:** `apps/api/src/routes/products.ts` (`POST /`),
  `apps/api/src/routes/stores.ts` (`POST /`)
- **Symptom:** inserting an existing barcode/code hit the UNIQUE
  constraint (23505) and surfaced as 500.
- **Fix:** new `isPgUniqueViolation()` / `isPgForeignKeyViolation()`
  helpers in `apps/api/src/db/index.ts`; both routes now return 409
  with a readable message.
- **Tests:** `routes.test.ts` — duplicate barcode → 409.

### B6 — Movements / Commander transactions against unknown store/product returned 500 (MEDIUM)
- **Files:** `apps/api/src/routes/movements.ts` (POST `/`, POST `/cycle-counts`),
  `apps/api/src/routes/commander.ts` (POST `/transactions`, POST `/price-book/import`)
- **Symptom:** the INSERT failed on the foreign key (23503) → 500.
  Also `POST /api/movements` accepted `qty: 0`, which built a
  zero-delta movement and only failed deep in validation.
- **Fix:** existence checks inside the transaction return 404 with a
  clear message; FK violations are mapped to 404 as a backstop;
  `qty` now rejects 0 in the zod schema.

### B7 — Overview showed every product at 0 on hand, par 0 (HIGH, UI)
- **File:** `apps/web/src/api.ts` — `getProducts()`; `apps/web/src/components/Overview.tsx`
- **Symptom:** Overview called `getProducts()` with no store, and the
  backend's catalog endpoint has no `on_hand`/`par_qty` columns, so the
  stock board rendered 0 on hand and par 0 for all 12 SKUs (totals
  cards were correct because they come from `/api/dashboard/summary`).
- **Fix:** `getProducts()` now defaults to the first (home) store via
  `defaultStoreId()`; a new `getCatalog()` keeps the catalog-only call
  for matching/classification, and `getMovements()` /
  `postInvoiceDraft()` / `pullPriceBook()` use it so products not
  stocked at the default store don't render with blank names.

### B8 — Low-stock alerts never fired on the Overview (MEDIUM, UI)
- **File:** `apps/web/src/components/Overview.tsx`
- **Symptom:** low was computed as `onHand <= reorderPoint`, but the
  backend has no `reorder_point` column, so `reorderPoint` is always 0
  and the condition was never true for in-stock items.
- **Fix:** low/out are now judged against `par` (`onHand > 0 && par > 0 && onHand < par`,
  out is `onHand <= 0 && par > 0`), matching the summary endpoint.

### B9 — Stores tab showed a hardcoded 30% margin for every store (MEDIUM, UI)
- **Files:** `apps/api/src/routes/stores.ts` (`GET /`),
  `apps/web/src/api.ts` — `mapStore()`
- **Symptom:** `mapStore()` hardcoded `marginPct: 30`, ignoring the real
  per-product margins in `product_stores`. After a save, the UI also
  reverted to 30 even though the backend had saved 10/15/20. (This is
  why the user's screenshot showed 010/015 — typed values, not stored ones.)
- **Fix:** `GET /api/stores` now returns each store's most common
  `margin_pct` (`mode() WITHIN GROUP`), and `mapStore()` uses it
  (30 only when the store carries nothing yet).

### B10 — Invoice draft qty/cost edits were silently ignored (HIGH, UI)
- **Files:** `apps/web/src/components/InvoiceScan.tsx`,
  `apps/web/src/api.ts` — `postInvoiceDraft()`,
  `apps/api/src/routes/invoices.ts` (new endpoint)
- **Symptom:** the draft table lets the user edit a line's qty/cost,
  but posting only sent line ids — the backend posted the original OCR
  values. An edited quantity never reached the ledger.
- **Fix:** new `PATCH /api/invoices/:id/lines/:lineId` (draft + unconfirmed
  lines only, qty ≥ 1, cost ≥ 0); `postInvoiceDraft()` PATCHes each
  confirmed line's edited values before confirming.

### B11 — Unmatched invoice lines could be ticked, then posting failed (MEDIUM, UI)
- **File:** `apps/web/src/components/InvoiceScan.tsx`
- **Symptom:** the confirm checkbox was enabled for unmatched lines,
  but the backend rejects confirming them — the user only learned that
  from a 400 after clicking Post. The helper text also wrongly said
  confirming an unmatched line would add it as a new product.
- **Fix:** checkbox disabled (with a tooltip) for unmatched lines;
  helper text corrected.

### B12 — Dashboard "stores" count only counted stores with stocked products (LOW)
- **File:** `apps/api/src/routes/dashboard.ts`
- **Symptom:** `COUNT(DISTINCT store_id)` over `store_inventory`
  omitted stores carrying nothing.
- **Fix:** stores count now comes from the `stores` table (1 when a
  single store is filtered).

### B13 — Missing "$" in Scan sale message (LOW, polish)
- **File:** `apps/web/src/components/Scan.tsx`
- **Symptom:** "Transaction total 3.88." — no currency sign.
- **Fix:** "Transaction total $3.88."

## Checked and found OK (no change)

- `apps/api/src/db/migrate.ts` / `seed.ts` / `index.ts` startup path:
  idempotent schema apply, `seedIfEmpty` only when no stores, opening
  receives only on a fresh ledger, seed par sums to 492. (Note:
  `seedIfEmpty` calls `main()`, which builds its own pool — works, but
  two API instances starting at once could both seed; the UNIQUE
  constraints make it safe, not clean.)
- `apps/api/src/ledger.ts` — zero-stock floor, sign rules, count-correction
  math all correct; `priceFromCost` rounding correct (existing tests).
- `apps/api/src/invoice.ts` — draft-only flow, unmatched lines can never
  be confirmed, re-confirm rejected, zero-line confirm rejected. All
  correct; the only gap was the UI edit path (B10/B11).
- `apps/api/src/routes/commander.ts` import — add-new-only, idempotent
  on re-import (ON CONFLICT DO NOTHING), inactive never imported.
- `apps/api/src/routes/products.ts` restock-all — only restocks below
  par; uses `resolveStoreId()` from 0.1.2.
- `apps/web/src/components/PosTerminal.tsx` — per-line on-hand caps are
  correct; partial-post on failure is warned in the error text.
  (Lines still post as separate movements, not one transaction — noted,
  not changed: the Commander route is the transactional path.)
- `apps/web/src/components/CycleCount.tsx` — the "blind count" copy is
  slightly misleading (the looked-up product object carries on-hand,
  though it isn't displayed); left as-is, cosmetic only.
- `apps/web/src/components/Stores.tsx` — save flow is correct once B9
  is fixed; margins state now round-trips through the backend.
- `apps/web/src/components/Receive.tsx`, `Ledger.tsx` — no contract
  mismatches found.

## Tests added

- `apps/api/tests/commander.test.ts` (+2): duplicate-UPC cumulative
  oversell (B1).
- `apps/api/tests/routes.test.ts` (new, 10 tests): `isUuid` /
  pg-error helpers; `resolveStoreId` by id (with `::uuid` cast, no
  `OR code`) and by code; rollout by UUID → 200 and by code → 200;
  `GET /api/products/not-a-uuid` → 404; `GET /api/products/:uuid` →
  200; duplicate barcode → 409. Routers run on a real Express app
  with a fake Pool that records the SQL sent.

## Version

Bumped to **0.1.3** in root `package.json` and `apps/api/package.json`
(code changed). `apps/web/package.json` stays at 0.1.0 (unchanged
convention — the web app is versioned with the repo root).

## Still open (not bugs in this sweep)

- The live Render database already has extra catalog rows from the
  accidental Commander price-book import during the 0.1.2 diagnosis
  (Red Bull etc., no stock attached). Harmless demo data; remove only
  if the user wants the catalog back to the original 12.
- Snickers / Pepsi demo barcodes still carry invalid UPC check digits
  (kept deliberately, per the code comments — do not "fix" silently).
- No real OCR engine wired yet (stub/sample providers only); real
  invoice-photo OCR is still untested against a live photo.
- No live Verifone connection — Commander feed is simulated, as labelled.
