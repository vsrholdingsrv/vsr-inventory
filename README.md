# VSR Inventory

Ledger-based inventory for convenience stores, built to plug into a live
Verifone Commander POS. One dashboard per store: what came in, what sold,
what's on the shelf right now, and what needs reordering — with the numbers
always derived from a movement ledger, never from a counter that can drift.

Built by **VSR HOLDINGS L.L.C** for its own stores and pilot customers.
First pilot: BNK Oil, Commerce Township, MI (Verifone Commander).

## What it does

- **Ledger inventory** — every stock change is a signed `Movement`
  (receive, sale, adjustment, count, transfer, return, damage, shrinkage).
  On-hand is always the sum of movements, floored at zero: a sale can
  never drive stock below zero, no matter what the feed does.
- **Zero-stock floor** — oversells and bad feed rows clamp at zero instead
  of going negative; the discrepancy is visible, not silently absorbed.
- **Commander Pull (add-new-only)** — imports the Commander price book and
  adds only SKUs that are genuinely new. Rows already in the catalog are
  `duplicate`, discontinued rows are `inactive`; neither is ever re-added
  or overwritten. New items are priced from cost with the store's own
  margin percent.
- **Invoice scan (draft-only)** — a supplier invoice is OCR'd into an
  `InvoiceDraft`. Nothing posts to the ledger until a human reviews every
  line, confirms the catalog match, and confirms the draft.
- **Multi-store rollout** — each store has its own catalog, ledger, and
  margin percent, so the same SKU can be priced differently per site.
- **Barcode scan** — UPC-A scanning in the browser via ZXing, with a
  check-digit validator (`isValidUpcA` in `packages/shared`) so a
  mis-scanned or mistyped barcode is caught before it becomes a product.
- **Blind cycle counts & reorder alerts** — counts are entered without
  seeing expected stock; on-hand at or below the reorder point raises an
  alert.

## Architecture

```
                    +------------------+
                    |  apps/web        |  React + TypeScript + Vite
                    |  (Static Site)   |  ZXing barcode scan, dashboard
                    +--------+---------+
                             |  REST (VITE_API_URL)
                    +--------v---------+
                    |  apps/api        |  Node.js + TypeScript + Express
                    |  (Web Service)   |  ledger, Commander Pull, invoice
                    |                  |  drafts, stores, auth
                    +--------+---------+
                             |  pg (DATABASE_URL)
                    +--------v---------+
                    |  Postgres 15     |  stores, products, movements,
                    |  (Render / local)|  price books, invoice drafts
                    +--------+---------+
                             |
              CommanderConnector interface (apps/api — see the API app's
              source for the exact file; the simulated feed lives there)
                             |
              +--------------+---------------+
              |  simulated feed (today)      |
              |  live Commander CGI/NAXML    |
              |  (after Verifone cert)       |
              +------------------------------+
```

Shared types and pure helpers (pricing, on-hand math, UPC-A validation,
price-book classification) live in `packages/shared` and are imported by
both apps — no duplication, no drift.

## Stack

| Layer    | Tech |
|----------|------|
| Frontend | React + TypeScript + Vite, ZXing barcode scanning |
| Backend  | Node.js 20+ + TypeScript + Express |
| Database | PostgreSQL 15 |
| Hosting (now) | Render — Web Service (api) + Postgres + Static Site (web) |
| Hosting (later) | AWS — ECS + RDS (see "Moving to AWS") |
| OCR      | Pluggable interface; stub by default (`OCR_PROVIDER=stub`) |

## Repo layout

```
vsr-inventory/
├── apps/
│   ├── api/                  # Express API (own Dockerfile, own README)
│   │   └── src/              # ledger, pricing, CommanderConnector
│   │                         # interface + simulated feed, pluggable OCR
│   │                         # interface (stub by default)
│   └── web/                  # React + Vite frontend (own Dockerfile)
├── packages/
│   └── shared/               # shared types + pure helpers (this repo's core)
│       └── src/index.ts
├── docker-compose.yml        # api + web + postgres:15 for local dev
├── .env.example
└── README.md
```

## Prerequisites

- Node.js 20+ and npm 10+
- Docker + Docker Compose (for the containerized local run), or a local
  Postgres 15 if you run the apps directly

## Local run

### Option A — Docker (recommended)

```bash
cp .env.example .env
docker compose up --build
```

- Web: http://localhost:5173
- API: http://localhost:4000 (health check: `GET /health`)
- Postgres: localhost:5432 (`vsr` / `vsr` / `vsr_inventory` by default)

Seed the demo catalog (12 sample SKUs) once the API is up:

```bash
npm run seed
```

### Option B — without Docker

```bash
cp .env.example .env        # point DATABASE_URL at your local Postgres
npm install
npm run dev                 # runs api (port 4000) + web (port 5173)
npm run seed                # demo catalog
```

Useful root scripts (npm workspaces — `apps/api`, `apps/web`,
`packages/shared`):

| Script | What it does |
|---|---|
| `npm run dev` | api + web in watch mode |
| `npm run build` | build all workspaces |
| `npm run typecheck` | `tsc --noEmit` in all workspaces |
| `npm run test` | tests in all workspaces |
| `npm run seed` | seed demo data via the api workspace |

## API overview

Base URL: `http://localhost:4000` locally (or the Render Web Service URL).
All money is integer cents; all quantities are integer units. The real
route list lives in `apps/api/src/routes/`; the main resources are:

| Resource | Purpose |
|---|---|
| `GET /health` | liveness check (used by Docker + Render health checks) |
| `GET /api/dashboard/summary` | totals, low stock, recent movements |
| `GET /api/products[?storeId=]` | catalog, per-store on-hand when storeId given |
| `POST /api/products/restock-all` | refill every product below par (ledger Receive movements) |
| `GET /api/stores` + `PATCH /api/stores/:id` | stores; `POST /api/stores/:id/rollout` sets per-product margins |
| `POST /api/movements` | append one ledger movement (zero-stock floor enforced) |
| `POST /api/movements/cycle-counts` | blind cycle count + correction |
| `GET /api/commander/price-book` | Commander Pull preview (simulated); `POST /api/commander/price-book/import` adds new items only |
| `POST /api/commander/transactions` | POS sale ingest, de-duplicated by transaction ID |
| `POST /api/invoices/scan` + `GET /api/invoices/sample` | invoice drafts (OCR) — draft only, never auto-posts |
| `POST /api/invoices/:id/confirm` | confirmed lines post Receive movements |

## Deploy to Render (step by step)

1. **Create the database** — Render Dashboard → New → PostgreSQL.
   Name it `vsr-inventory-db`, pick the free/starter plan, note the
   **Internal Database URL**.
2. **Create the API service** — New → Web Service → connect this repo.
   - Root directory: `apps/api`
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Environment variables:
     - `DATABASE_URL` = the Internal Database URL from step 1
     - `NODE_ENV=production`
     - `OCR_PROVIDER=sample` (demo Core-Mark invoice; `stub` refuses to guess until a real OCR engine is wired in — see `apps/api/src/invoice.ts`)
   - Health check path: `/health`
3. **Create the web site** — New → Static Site → connect this repo.
   - Root directory: `apps/web`
   - Build command: `npm install && npm run build`
   - Publish directory: `dist`
   - Environment variable:
     - `VITE_API_URL` = the API service URL from step 2
       (e.g. `https://vsr-inventory-api.onrender.com`)
4. **Seed** — from your machine, with the Render database URL:
   `DATABASE_URL=<internal-url> npm run seed --workspace=apps/api`
   (or run the seed once against the Render service's shell).
5. Verify: open the Static Site URL, confirm the dashboard loads and the
   API health check returns OK.

## Moving to AWS later

The app is already shaped for the move; nothing in the code assumes Render.

- **API → ECS (Fargate):** the `apps/api/Dockerfile` is the same image.
  Run it as a Fargate service behind an Application Load Balancer, with
  the `/health` endpoint as the target-group health check.
- **Postgres → RDS (Postgres 15):** point `DATABASE_URL` at the RDS
  endpoint. Run migrations on deploy (same as Render); no schema change.
- **Web → S3 + CloudFront:** `npm run build` output (`dist/`) is static;
  sync it to S3 and serve through CloudFront. `VITE_API_URL` is baked in
  at build time, so rebuild when the API URL changes.
- **Secrets:** move `DATABASE_URL` and any future OCR/API keys to AWS
  Secrets Manager or SSM Parameter Store; keep `OCR_PROVIDER` as an
  environment variable so the provider can be swapped without a redeploy
  of code.
- **Commander connectivity:** a live Commander talks to the API over the
  store network / VPN — that link is established during Verifone
  certification (see below), not by the hosting move.

## What is simulated vs real

Be honest about this — the product must never claim a live connection it
doesn't have.

- **NO live Verifone Commander connection yet.** There is no live feed,
  no CGI/NAXML link, and no store data flowing from a real Commander.
- **Simulated Commander feed** — the API app ships a simulator (behind
  the `CommanderConnector` interface) that generates POS sales and a
  sample price book so the dashboard, ledger, and Commander Pull can be
  exercised end to end.
- **The swap point is the `CommanderConnector` interface** in the API app.
  The live implementation (CGI/NAXML against a real Commander) implements
  the same interface; flipping from simulated to live is a config change
  (`COMMANDER_MODE=live`), not a rewrite.
- **Invoice OCR is a pluggable interface** (in the API app),
  stub by default. The stub returns no text and forces manual line entry.
  A real provider (Tesseract, AWS Textract, …) plugs in behind the same
  interface — and the draft-still-needs-a-human rule does not change.
- **Ledger, pricing, UPC-A validation, and price-book classification are
  real** — pure functions in `packages/shared`, covered by tests, and the
  same code runs in the API and the web app.

## Known data caveats

- The demo seed contains two barcodes with **invalid UPC-A check digits**
  — they came from the prototype's sample data and do not match any real
  pack:
  - Snickers — `040000001017` (invalid)
  - Pepsi — `012000000927` (invalid)
  
  Fix them from the numbers actually printed on real packs before the
  pilot store goes live. The validator (`isValidUpcA`) will flag them.
- Coca-Cola — `049000050103` — is valid and can be used as a reference
  while scanning works.
- Until the live Commander link exists, sales in the dashboard are
  simulated and must not be presented as real store sales.

## Next step — Verifone discovery call

**Tuesday, December 29, 2026, 12:00–12:30 PM EST** — Teams discovery call
with **Jason Williams (Verifone)** about the Horizon partner application
(submitted November 22, 2026) and the path to a live Commander
integration: CGI/NAXML access, the Clearwater lab certification process,
and what a pilot connection at BNK Oil requires. Meeting ID
`279 978 731 897 536 2`. A call script is kept with the project docs.
An earlier slot in early December was requested as well, with Dec 29 kept
as the backup.

## License

MIT — see [LICENSE](LICENSE).
