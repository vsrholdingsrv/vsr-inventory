/**
 * pricing.ts — pure shelf-price math.
 *
 * priceFromCost(cost, marginPct) = round(cost * (1 + marginPct / 100))
 * All money is integer cents; the result is rounded to the nearest cent.
 */

/** Shelf price in cents from unit cost and a target margin percentage. */
export function priceFromCost(costCents: number, marginPct: number): number {
  if (!Number.isFinite(costCents) || costCents < 0) {
    throw new Error('costCents must be a finite number >= 0');
  }
  if (!Number.isFinite(marginPct) || marginPct < 0) {
    throw new Error('marginPct must be a finite number >= 0');
  }
  return Math.round(costCents * (1 + marginPct / 100));
}

/** Implied margin percentage from a known cost and shelf price. */
export function marginPctFromCostAndPrice(
  costCents: number,
  priceCents: number,
): number {
  if (!Number.isFinite(costCents) || costCents <= 0) {
    throw new Error('costCents must be a finite number > 0');
  }
  if (!Number.isFinite(priceCents) || priceCents < 0) {
    throw new Error('priceCents must be a finite number >= 0');
  }
  return ((priceCents - costCents) / costCents) * 100;
}
