import { describe, it, expect } from 'vitest';
import { marginPctFromCostAndPrice, priceFromCost } from '../src/pricing';

describe('priceFromCost', () => {
  it.each([
    [10, 110],
    [20, 120],
    [25, 125],
    [30, 130],
  ])('%i%% margin on $1.00 (100c) -> %ic', (marginPct, expected) => {
    expect(priceFromCost(100, marginPct)).toBe(expected);
  });

  it('rounds to the nearest cent', () => {
    // 199 * 1.30 = 258.7 -> 259
    expect(priceFromCost(199, 30)).toBe(259);
    // 45 * 1.10 = 49.5 -> 50 (round half up)
    expect(priceFromCost(45, 10)).toBe(50);
  });

  it('returns 0 for zero cost', () => {
    expect(priceFromCost(0, 30)).toBe(0);
  });

  it('returns cost unchanged at 0% margin', () => {
    expect(priceFromCost(250, 0)).toBe(250);
  });

  it('rejects negative cost or margin', () => {
    expect(() => priceFromCost(-1, 10)).toThrow();
    expect(() => priceFromCost(100, -5)).toThrow();
  });
});

describe('marginPctFromCostAndPrice', () => {
  it('recovers the margin from a known cost and price', () => {
    expect(marginPctFromCostAndPrice(100, 130)).toBeCloseTo(30);
    expect(marginPctFromCostAndPrice(45, 149)).toBeCloseTo(231.11, 1);
  });
});
