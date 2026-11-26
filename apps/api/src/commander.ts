/**
 * commander.ts — Verifone Commander integration point.
 *
 * *** SIMULATED — NO LIVE CONNECTION ***
 * There is no real connection to a Verifone Commander here. The
 * SimulatedCommanderConnector below replays a fixed 20-item price book
 * and accepts transactions against in-memory state, so the dashboard,
 * ledger and import flows can be built and tested end to end.
 *
 * After Verifone Horizon approval, a real connector implementing the same
 * CommanderConnector interface (CGI / NAXML over the store network)
 * swaps in here — same method signatures, same return shapes — and this
 * simulated class is deleted, not extended. Nothing else in the codebase
 * may depend on simulated data: routes talk only to the interface.
 */

export interface PriceBookItem {
  upc: string;
  name: string;
  category: string;
  costCents: number;
  priceCents: number;
  /** Inactive items are discontinued at the Commander and must never import. */
  active: boolean;
}

export interface CommanderTransactionLine {
  upc: string;
  qty: number;
  priceCents: number;
  costCents?: number;
}

export interface CommanderTransaction {
  transactionId: string;
  storeId: string;
  registerId: string;
  lines: CommanderTransactionLine[];
  totalCents: number;
  occurredAt?: string;
}

export interface PostedLine {
  upc: string;
  qty: number;
  /** Movement type that was (or would be) posted to the ledger. */
  movementType: 'sale';
}

export interface UnmatchedLine {
  line: CommanderTransactionLine;
  reason: 'unmatched' | 'insufficient_stock';
  detail: string;
}

export interface IngestResult {
  transactionId: string;
  /** false only when this transaction_id was already seen (de-dupe). */
  accepted: boolean;
  duplicate: boolean;
  postedLines: PostedLine[];
  unmatchedLines: UnmatchedLine[];
}

/**
 * The contract any Commander connector — simulated or real — must satisfy.
 * ingestTransaction must be idempotent on transactionId: a replayed
 * transaction returns { accepted: false, duplicate: true } and posts nothing.
 */
export interface CommanderConnector {
  pullPriceBook(): Promise<PriceBookItem[]>;
  ingestTransaction(tx: CommanderTransaction): Promise<IngestResult>;
}

// ---------------------------------------------------------------------------
// Simulated price book (20 items, as used by the prototype).
//
// NOTE on check digits: Snickers 040000001017 and Pepsi 012000000927 have
// INVALID UPC check digits (the correct check digits would be 0 and 8).
// They are kept exactly as printed here on purpose — the prototype's demo
// SKUs carry the same numbers, and silently "fixing" them would break the
// match against the seeded catalog. Do not change these UPCs.
// ---------------------------------------------------------------------------
export const SIMULATED_PRICE_BOOK: PriceBookItem[] = [
  // Duplicates of the seeded demo catalog (3) — must be skipped on import.
  { upc: '049000050103', name: 'Coca-Cola 20oz', category: 'Beverage', costCents: 110, priceCents: 199, active: true },
  { upc: '040000001017', name: 'Snickers Bar 1.86oz', category: 'Snack', costCents: 95, priceCents: 189, active: true },
  { upc: '012000000927', name: 'Pepsi 20oz', category: 'Beverage', costCents: 105, priceCents: 199, active: true },
  // New items (16) — the only ones an import may add.
  { upc: '070847811169', name: 'Monster Energy 16oz', category: 'Beverage', costCents: 165, priceCents: 299, active: true },
  { upc: '611269991000', name: 'Red Bull 8.4oz', category: 'Beverage', costCents: 185, priceCents: 329, active: true },
  { upc: '049000028904', name: 'Dasani Water 20oz', category: 'Beverage', costCents: 55, priceCents: 149, active: true },
  { upc: '061300873525', name: 'Arizona Green Tea 23oz', category: 'Beverage', costCents: 85, priceCents: 179, active: true },
  { upc: '028400642054', name: 'Doritos Nacho Cheese 2.75oz', category: 'Snack', costCents: 135, priceCents: 249, active: true },
  { upc: '028400064107', name: "Lay's Classic 2.625oz", category: 'Snack', costCents: 135, priceCents: 249, active: true },
  { upc: '034000480109', name: "Reese's Peanut Butter Cups 1.5oz", category: 'Snack', costCents: 95, priceCents: 189, active: true },
  { upc: '034000245502', name: 'Kit Kat Bar 1.5oz', category: 'Snack', costCents: 90, priceCents: 179, active: true },
  { upc: '012546011205', name: 'Trident Gum 14-stick', category: 'Snack', costCents: 80, priceCents: 169, active: true },
  { upc: '070470004201', name: 'Milk Whole Gallon', category: 'Dairy', costCents: 320, priceCents: 429, active: true },
  { upc: '071610703406', name: 'Eggs Large 12ct', category: 'Dairy', costCents: 260, priceCents: 399, active: true },
  { upc: '074653245601', name: 'Frozen Pizza Pepperoni', category: 'Frozen', costCents: 420, priceCents: 699, active: true },
  { upc: '070847900118', name: 'Bagged Ice 20lb', category: 'General', costCents: 300, priceCents: 599, active: true },
  { upc: '030573016202', name: 'Advil 50ct', category: 'Health', costCents: 450, priceCents: 799, active: true },
  { upc: '037000138985', name: 'Tide Detergent 100oz', category: 'Household', costCents: 950, priceCents: 1499, active: true },
  { upc: '074130410303', name: 'Motor Oil 5W-30 1qt', category: 'Automotive', costCents: 520, priceCents: 899, active: true },
  // Inactive / discontinued (1) — must be skipped on import.
  { upc: '098765432109', name: "Old Timer's Jerky 3oz", category: 'Snack', costCents: 350, priceCents: 599, active: false },
];

export type PriceBookClassification = 'new' | 'duplicate' | 'inactive';

export interface ClassifiedPriceBookItem {
  item: PriceBookItem;
  classification: PriceBookClassification;
  reason: string;
}

export interface CatalogEntry {
  upc: string;
}

/**
 * Classify every price-book item against the current catalog.
 * - inactive: item.active is false (discontinued — never import).
 * - duplicate: UPC already exists in the catalog.
 * - new: everything else; the only class an import may add.
 */
export function classifyPriceBook(
  items: ReadonlyArray<PriceBookItem>,
  catalog: ReadonlyArray<CatalogEntry>,
): ClassifiedPriceBookItem[] {
  const known = new Set(catalog.map((c) => c.upc));
  return items.map((item) => {
    if (!item.active) {
      return { item, classification: 'inactive', reason: 'Inactive at Commander (discontinued)' };
    }
    if (known.has(item.upc)) {
      return { item, classification: 'duplicate', reason: 'UPC already in catalog' };
    }
    return { item, classification: 'new', reason: 'Not in catalog' };
  });
}

export interface PriceBookImportResult {
  added: PriceBookItem[];
  skipped: ClassifiedPriceBookItem[];
  /** Add-new-only imports never update existing products. Always 0. */
  updated: 0;
}

/**
 * Add-new-only import: returns the items that may be created as products.
 * Duplicates and inactive items are skipped, never updated or reactivated.
 * This function is pure — the caller persists `added` and records the
 * price_book_imports audit row.
 */
export function importPriceBook(
  items: ReadonlyArray<PriceBookItem>,
  catalog: ReadonlyArray<CatalogEntry>,
): PriceBookImportResult {
  const classified = classifyPriceBook(items, catalog);
  return {
    added: classified
      .filter((c) => c.classification === 'new')
      .map((c) => c.item),
    skipped: classified.filter((c) => c.classification !== 'new'),
    updated: 0,
  };
}

export interface IngestContext {
  /** On-hand units by UPC for the transaction's store. */
  onHandByUpc: ReadonlyMap<string, number>;
  /** Transaction ids already ingested (DB: pos_transactions.transaction_id). */
  seenTransactionIds: ReadonlySet<string>;
}

/**
 * Pure transaction ingest: de-dupe + zero-stock floor, no side effects.
 *
 * - Replayed transaction_id -> { accepted: false, duplicate: true }, nothing posts.
 * - A line whose UPC has no on-hand entry is 'unmatched' (unknown product).
 * - A line whose qty exceeds on-hand is 'insufficient_stock' — blocked,
 *   recorded as a pos_event, and NEVER allowed to drive stock negative.
 * - Only lines that pass both checks land in postedLines (sale movements).
 */
export function ingestVerifoneTransaction(
  tx: CommanderTransaction,
  ctx: IngestContext,
): IngestResult {
  if (ctx.seenTransactionIds.has(tx.transactionId)) {
    return {
      transactionId: tx.transactionId,
      accepted: false,
      duplicate: true,
      postedLines: [],
      unmatchedLines: [],
    };
  }

  const postedLines: PostedLine[] = [];
  const unmatchedLines: UnmatchedLine[] = [];

  for (const line of tx.lines) {
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      unmatchedLines.push({
        line,
        reason: 'unmatched',
        detail: `Invalid qty ${line.qty} for UPC ${line.upc}`,
      });
      continue;
    }
    const onHand = ctx.onHandByUpc.get(line.upc);
    if (onHand === undefined) {
      unmatchedLines.push({
        line,
        reason: 'unmatched',
        detail: `UPC ${line.upc} is not in the catalog for this store`,
      });
      continue;
    }
    if (line.qty > onHand) {
      unmatchedLines.push({
        line,
        reason: 'insufficient_stock',
        detail: `Only ${onHand} on hand for UPC ${line.upc}, tried to sell ${line.qty}`,
      });
      continue;
    }
    postedLines.push({ upc: line.upc, qty: line.qty, movementType: 'sale' });
  }

  return {
    transactionId: tx.transactionId,
    accepted: true,
    duplicate: false,
    postedLines,
    unmatchedLines,
  };
}

/**
 * Simulated Commander connector (in-memory).
 *
 * - pullPriceBook() replays SIMULATED_PRICE_BOOK.
 * - ingestTransaction() de-dupes on transactionId for the life of the
 *   instance and checks lines against the injected on-hand lookup.
 * - The optional onSale callback lets a host apply posted lines to its own
 *   ledger; without it, posted lines are reported but not persisted.
 *   Production routes do NOT use this class for persistence — they run the
 *   same pure ingestVerifoneTransaction() against the database.
 */
export class SimulatedCommanderConnector implements CommanderConnector {
  private readonly seen = new Set<string>();
  private readonly getOnHandByUpc: (
    storeId: string,
  ) => ReadonlyMap<string, number>;
  private readonly onSale?: (
    tx: CommanderTransaction,
    line: PostedLine,
  ) => void;

  constructor(
    getOnHandByUpc: (
      storeId: string,
    ) => ReadonlyMap<string, number> = () => new Map(),
    onSale?: (tx: CommanderTransaction, line: PostedLine) => void,
  ) {
    this.getOnHandByUpc = getOnHandByUpc;
    this.onSale = onSale;
  }

  async pullPriceBook(): Promise<PriceBookItem[]> {
    // Return copies so callers cannot mutate the shared simulated book.
    return SIMULATED_PRICE_BOOK.map((item) => ({ ...item }));
  }

  async ingestTransaction(tx: CommanderTransaction): Promise<IngestResult> {
    const result = ingestVerifoneTransaction(tx, {
      onHandByUpc: this.getOnHandByUpc(tx.storeId),
      seenTransactionIds: this.seen,
    });
    if (result.accepted) {
      this.seen.add(tx.transactionId);
      if (this.onSale) {
        for (const line of result.postedLines) this.onSale(tx, line);
      }
    }
    return result;
  }
}
