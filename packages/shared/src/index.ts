/**
 * @vsr/shared — shared types and pure helpers for VSR Inventory.
 *
 * This package has NO runtime dependencies and touches no I/O, no Node APIs
 * and no DOM APIs, so it is safe to import from both the Express API and the
 * Vite/React web app. Anything that needs a database, a network call, or the
 * Verifone Commander lives in apps/api, not here.
 *
 * Money is always integer cents. Quantities are integer units.
 * Movement quantities are SIGNED deltas: positive adds stock, negative
 * removes it. On-hand stock is floored at zero (the zero-stock floor).
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A product carried by a store. Prices/costs are integer cents. */
export interface Product {
  id: string;
  storeId: string;
  /** Display name, e.g. "Coca-Cola 20oz". */
  name: string;
  /** 12-digit UPC-A barcode (may be an empty string for unbarcoded items). */
  upc: string;
  /** Unit cost in cents. */
  costCents: number;
  /** Unit selling price in cents. */
  priceCents: number;
  /** Margin percent this price was derived from, if any. */
  marginPct?: number;
  /** Target on-hand level the store restocks to. */
  parLevel: number;
  /** On-hand level at or below which a reorder alert fires. */
  reorderPoint: number;
  /** Shelf / cooler location inside the store, e.g. "Cooler 2". */
  location?: string;
  supplier?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A convenience-store location. Each store carries its own margin. */
export interface Store {
  id: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  /** POS system installed at the store. */
  posType: 'verifone-commander' | 'other';
  /**
   * Default gross-margin percent applied when pricing new items pulled in
   * from the Commander price book (e.g. 35 = 35%). Per-store so a
   * high-traffic site and a rural site can price the same SKU differently.
   */
  marginPct: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** How stock moved. The sign of `quantity` follows the type. */
export type MovementType =
  | 'receive' // stock in from a supplier delivery / invoice
  | 'sale' // stock out via a POS sale (negative quantity)
  | 'adjustment' // manual correction (signed)
  | 'count' // blind cycle-count correction (signed delta vs. counted)
  | 'transfer' // signed: +in to this store, -out of it
  | 'return' // stock back to supplier (negative) or customer return (+)
  | 'damage' // stock out: damaged / expired / spoiled (negative)
  | 'shrinkage'; // stock out: theft / loss found at count (negative)

/**
 * One ledger entry. Inventory is a ledger: on-hand is always the sum of
 * movements, never a stored counter that can drift. `quantity` is a signed
 * delta in units; `reasonCode` explains the movement ("delivery",
 * "expired", "cycle-count", ...).
 */
export interface Movement {
  id: string;
  storeId: string;
  productId: string;
  type: MovementType;
  /** Signed units: positive adds stock, negative removes it. */
  quantity: number;
  reasonCode?: string;
  /** Free-form reference: invoice no., POS transaction id, count id, ... */
  reference?: string;
  createdAt: string;
  createdBy?: string;
}

/** One row of a Verifone Commander price book (CGI / NAXML export). */
export interface PriceBookItem {
  /** 12-digit UPC-A barcode. */
  upc: string;
  name: string;
  /** Unit cost in cents, when the price book carries it. */
  costCents?: number;
  /** Unit selling price in cents, when the price book carries it. */
  priceCents?: number;
  department?: string;
  /** False for discontinued / inactive SKUs in the price book. */
  active?: boolean;
}

/** Classification of a price-book row against the store's live catalog. */
export type PriceBookClassification = 'new' | 'duplicate' | 'inactive';

/** One line of a supplier invoice being received into stock. */
export interface InvoiceLine {
  /** UPC-A of the invoiced item, when printed on the invoice. */
  upc?: string;
  /** Product id once the line is matched to the catalog (drafts: unset). */
  productId?: string;
  name: string;
  quantity: number;
  /** Unit cost in cents from the invoice. */
  costCents: number;
  /** True once a human has confirmed the catalog match for this line. */
  matched: boolean;
}

/**
 * A supplier invoice captured by OCR. ALWAYS a draft: nothing posts to the
 * ledger until a human reviews every line and confirms. See `status`.
 */
export interface InvoiceDraft {
  id: string;
  storeId: string;
  supplier: string;
  invoiceNumber?: string;
  status: 'draft' | 'confirmed' | 'voided';
  lines: InvoiceLine[];
  /** Raw OCR text, kept for audit / re-review. */
  rawText?: string;
  createdAt: string;
  confirmedAt?: string;
}

/** One POS sale as it arrives from the Commander (or the simulator). */
export interface PosTransaction {
  id: string;
  storeId: string;
  occurredAt: string;
  items: PosTransactionItem[];
  /** Total charged, in cents. */
  totalCents: number;
  /** 'commander' = live Verifone feed; 'simulated' = demo feed. */
  source: 'commander' | 'simulated' | 'manual';
}

/** One line of a POS sale. */
export interface PosTransactionItem {
  upc: string;
  quantity: number;
  /** Unit price actually charged, in cents. */
  priceCents: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Selling price in integer cents from a unit cost and a margin percent.
 * price = cost * (1 + marginPct / 100), rounded to the nearest cent.
 *
 * @throws RangeError when costCents is negative or marginPct is < -100
 *   (a margin below -100% would price the item below zero).
 */
export function priceFromCost(costCents: number, marginPct: number): number {
  if (!Number.isFinite(costCents) || !Number.isFinite(marginPct)) {
    throw new RangeError('priceFromCost: costCents and marginPct must be finite numbers');
  }
  if (costCents < 0) {
    throw new RangeError('priceFromCost: costCents must not be negative');
  }
  if (marginPct < -100) {
    throw new RangeError('priceFromCost: marginPct must not be below -100');
  }
  return Math.round(costCents * (1 + marginPct / 100));
}

/**
 * On-hand units for a product from its ledger movements. Sums the signed
 * quantities and floors the result at zero — the zero-stock floor: a sale
 * can never drive on-hand below zero, no matter how the feed behaves.
 */
export function computeOnHand(movements: readonly Movement[]): number {
  let onHand = 0;
  for (const m of movements) {
    onHand += m.quantity;
  }
  return Math.max(0, onHand);
}

/**
 * On-hand units per product id, from a mixed list of movements.
 * Products with no movements are absent from the result (not zero-filled);
 * every value is floored at zero.
 */
export function computeOnHandByProduct(
  movements: readonly Movement[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const m of movements) {
    totals.set(m.productId, (totals.get(m.productId) ?? 0) + m.quantity);
  }
  for (const [productId, qty] of totals) {
    totals.set(productId, Math.max(0, qty));
  }
  return totals;
}

/**
 * UPC-A check-digit validator. Accepts exactly 12 digits; the 12th digit
 * must equal the check digit computed from the first 11:
 *   sum(odd-position digits) * 3 + sum(even-position digits),
 *   check = (10 - (sum % 10)) % 10.
 * (Positions are 1-based over the first 11 digits.)
 *
 * Known demo-seed results: "049000050103" (Coke) is valid;
 * "040000001017" (Snickers) and "012000000927" (Pepsi) are NOT valid —
 * their check digits are wrong in the seed data and must be fixed from the
 * numbers actually printed on real packs.
 */
export function isValidUpcA(barcode: string): boolean {
  if (!/^\d{12}$/.test(barcode)) {
    return false;
  }
  const digits = barcode.split('').map((d) => Number(d));
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    // i is 0-based; position i+1 is odd when i is even.
    sum += i % 2 === 0 ? (digits[i] ?? 0) * 3 : (digits[i] ?? 0);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (digits[11] ?? -1);
}

/**
 * Classify one Commander price-book row against the store's live catalog.
 *
 * - 'inactive'   — the row is flagged inactive/discontinued in the price
 *   book, regardless of whether the UPC already exists.
 * - 'duplicate'  — the UPC already exists in the catalog (do not re-add).
 * - 'new'        — active row with an UPC not in the catalog: the only
 *   rows Commander Pull is allowed to add.
 *
 * `existingUpcs` is the set (or list) of UPCs already in the catalog for
 * this store.
 */
export function classifyPriceBook(
  item: PriceBookItem,
  existingUpcs: ReadonlySet<string> | readonly string[],
): PriceBookClassification {
  if (item.active === false) {
    return 'inactive';
  }
  const existing = new Set<string>(existingUpcs);
  return existing.has(item.upc) ? 'duplicate' : 'new';
}

/**
 * Classify a whole price-book import. Returns the rows grouped by
 * classification, preserving the price book's original order within each
 * group. Only the `new` group may be added to the catalog (Commander Pull
 * is add-new-only).
 */
export function classifyPriceBookBatch(
  items: readonly PriceBookItem[],
  existingUpcs: ReadonlySet<string> | readonly string[],
): Record<PriceBookClassification, PriceBookItem[]> {
  const result: Record<PriceBookClassification, PriceBookItem[]> = {
    new: [],
    duplicate: [],
    inactive: [],
  };
  for (const item of items) {
    result[classifyPriceBook(item, existingUpcs)].push(item);
  }
  return result;
}
