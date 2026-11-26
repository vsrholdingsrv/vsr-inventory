/**
 * ledger.ts — pure inventory-ledger functions.
 *
 * No database, no I/O. Every stock change in VSR Inventory is a movement
 * row (see src/db/schema.sql); on-hand is ALWAYS derived:
 *   on_hand(store, product) = SUM(qty_delta) over that store+product.
 * These functions are the only place the zero-stock floor lives.
 */

export type MovementType =
  | 'receive'
  | 'sale'
  | 'waste'
  | 'damage'
  | 'expired'
  | 'shrinkage'
  | 'transfer-out'
  | 'return'
  | 'count-correction';

export interface LedgerMovement {
  id?: string;
  store_id: string;
  product_id: string;
  type: MovementType;
  /** Positive = stock in, negative = stock out. Never 0. */
  qty_delta: number;
  cost_cents?: number | null;
  note?: string | null;
  created_at?: string | Date;
}

/** Movement types that take stock OUT of the store. */
export const OUTGOING_TYPES: ReadonlySet<MovementType> = new Set([
  'sale',
  'waste',
  'damage',
  'expired',
  'shrinkage',
  'transfer-out',
]);

/** Movement types that bring stock IN (count-correction may go either way). */
export const INCOMING_TYPES: ReadonlySet<MovementType> = new Set([
  'receive',
  'return',
]);

export function isOutgoing(type: MovementType): boolean {
  return OUTGOING_TYPES.has(type);
}

export function isIncoming(type: MovementType): boolean {
  return INCOMING_TYPES.has(type);
}

/** On-hand from a list of movements for one store+product. */
export function computeOnHand(
  movements: ReadonlyArray<Pick<LedgerMovement, 'qty_delta'>>,
): number {
  return movements.reduce((sum, m) => sum + m.qty_delta, 0);
}

/** On-hand per product id, from a mixed list of movements. */
export function computeOnHandByProduct(
  movements: ReadonlyArray<LedgerMovement>,
): Map<string, number> {
  const onHand = new Map<string, number>();
  for (const m of movements) {
    onHand.set(m.product_id, (onHand.get(m.product_id) ?? 0) + m.qty_delta);
  }
  return onHand;
}

/**
 * Error thrown when a movement would drive on-hand below zero.
 * Message format is part of the contract: `Only ${onHand} on hand`.
 */
export class InsufficientStockError extends Error {
  readonly onHand: number;
  readonly requested: number;

  constructor(onHand: number, requested: number) {
    super(`Only ${onHand} on hand`);
    this.name = 'InsufficientStockError';
    this.onHand = onHand;
    this.requested = requested;
  }
}

/**
 * Validate a single movement against current on-hand.
 *
 * Rules:
 * - qty_delta must be a non-zero integer.
 * - 'receive' / 'return' must be positive; outgoing types must be negative.
 * - 'count-correction' may be either sign (it sets stock to the counted value).
 * - The resulting on-hand must never drop below 0 (zero-stock floor).
 *
 * Throws InsufficientStockError (or a plain Error for sign/type misuse).
 * Returns the resulting on-hand on success.
 */
export function validateMovement(
  movement: Pick<LedgerMovement, 'type' | 'qty_delta'>,
  onHand: number,
): number {
  const { type, qty_delta } = movement;

  if (!Number.isInteger(qty_delta) || qty_delta === 0) {
    throw new Error('qty_delta must be a non-zero integer');
  }
  if (isIncoming(type) && qty_delta < 0) {
    throw new Error(`'${type}' movements must have a positive qty_delta`);
  }
  if (isOutgoing(type) && qty_delta > 0) {
    throw new Error(`'${type}' movements must have a negative qty_delta`);
  }

  const resulting = onHand + qty_delta;
  if (resulting < 0) {
    throw new InsufficientStockError(onHand, Math.abs(qty_delta));
  }
  return resulting;
}

/**
 * Pure append: validate the movement, then return a new movement list
 * and the new on-hand. The caller's list is not mutated.
 */
export function applyMovement(
  movements: ReadonlyArray<LedgerMovement>,
  movement: LedgerMovement,
): { movements: LedgerMovement[]; onHand: number } {
  const onHand = computeOnHand(movements);
  const newOnHand = validateMovement(movement, onHand);
  return { movements: [...movements, movement], onHand: newOnHand };
}

/** Build a movement object from a human-friendly unsigned quantity. */
export function buildMovement(
  input: {
    storeId: string;
    productId: string;
    type: MovementType;
    /** Unsigned qty for receive/return/outgoing; signed delta for count-correction. */
    qty: number;
    costCents?: number;
    note?: string;
  },
): LedgerMovement {
  const { storeId, productId, type, qty, costCents, note } = input;
  let qtyDelta: number;
  if (type === 'count-correction') {
    qtyDelta = qty; // caller passes the signed variance
  } else if (isOutgoing(type)) {
    qtyDelta = -Math.abs(qty);
  } else {
    qtyDelta = Math.abs(qty);
  }
  return {
    store_id: storeId,
    product_id: productId,
    type,
    qty_delta: qtyDelta,
    cost_cents: costCents ?? null,
    note: note ?? null,
  };
}

export interface CountInput {
  expectedQty: number;
  countedQty: number;
}

/**
 * Variance for a blind cycle count. Positive = found more than expected
 * (stock goes up); negative = short (stock goes down). A zero variance
 * posts no movement — there is nothing to correct.
 */
export function recordCount(input: CountInput): {
  variance: number;
  qtyDelta: number;
  type: 'count-correction';
  postsMovement: boolean;
} {
  const { expectedQty, countedQty } = input;
  if (!Number.isInteger(expectedQty) || expectedQty < 0) {
    throw new Error('expectedQty must be a non-negative integer');
  }
  if (!Number.isInteger(countedQty) || countedQty < 0) {
    throw new Error('countedQty must be a non-negative integer');
  }
  const variance = countedQty - expectedQty;
  return {
    variance,
    qtyDelta: variance,
    type: 'count-correction',
    postsMovement: variance !== 0,
  };
}
