# Contributing to VSR Inventory

Short version: this is a small, owner-operated codebase. Keep changes
small, honest, and covered by the shared package's rules below.

## Ground rules

- **Never fake a live connection.** The Verifone Commander link is
  simulated until certification says otherwise. Any change that would make
  the dashboard present simulated sales or a simulated price book as real
  store data is out of scope.
- **The ledger is append-only.** Fix bad stock with a correcting movement,
  never by editing or deleting an existing movement row.
- **Money is integer cents, quantities are integer units.** No floats for
  money anywhere in the codebase.
- **Shared logic lives in `packages/shared`.** If both the API and the web
  app need it (pricing, on-hand math, UPC validation, price-book
  classification), it goes in `packages/shared/src/index.ts` — not copied
  into each app.
- **Invoice drafts stay draft-only.** OCR output never posts to the ledger
  without a human confirming every line.
- **Commander Pull is add-new-only.** Never change it to update or
  overwrite existing catalog rows.

## Workflow

1. Branch from `main` (`feature/<short-name>`).
2. `npm install`, then `npm run dev` to work locally
   (or `docker compose up --build`).
3. Keep `npm run typecheck` and `npm run test` green.
4. Open a pull request describing what changed and what you verified
   against a real store flow (or the simulator, if no store was involved).
5. Don't commit `.env`, credentials, or real store data. Sample/demo data
   only — and if a sample barcode fails `isValidUpcA`, say so in the PR
   instead of quietly shipping it.

## Getting help

Questions about the Verifone integration path go to the repo owner
(VSR HOLDINGS L.L.C) — the Dec 29, 2026 discovery call with Jason Williams
is the current source of truth for what comes next.
