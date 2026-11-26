import { describe, it, expect } from 'vitest';
import {
  applyMovement,
  buildMovement,
  computeOnHand,
  InsufficientStockError,
  LedgerMovement,
  recordCount,
  validateMovement,
} from '../src/ledger';

const STORE = '00000000-0000-0000-0000-000000000001';
const PRODUCT = '00000000-0000-0000-0000-000000000002';

function receive(qty: number): LedgerMovement {
  return buildMovement({ storeId: STORE, productId: PRODUCT, type: 'receive', qty });
}

function sale(qty: number): LedgerMovement {
  return buildMovement({ storeId: STORE, productId: PRODUCT, type: 'sale', qty });
}

describe('computeOnHand', () => {
  it('sums qty_delta across movements', () => {
    expect(computeOnHand([receive(10), sale(3), receive(2)])).toBe(9);
  });

  it('is 0 with no movements', () => {
    expect(computeOnHand([])).toBe(0);
  });
});

describe('zero-stock floor', () => {
  it('allows a sale within on-hand', () => {
    const { onHand } = applyMovement([receive(5)], sale(3));
    expect(onHand).toBe(2);
  });

  it('allows selling exactly the on-hand quantity, down to zero', () => {
    const { onHand, movements } = applyMovement([receive(5)], sale(5));
    expect(onHand).toBe(0);
    expect(computeOnHand(movements)).toBe(0);
  });

  it('rejects a sale that would take stock below zero', () => {
    expect(() => applyMovement([receive(5)], sale(6))).toThrow(InsufficientStockError);
    expect(() => applyMovement([receive(5)], sale(6))).toThrow('Only 5 on hand');
  });

  it('rejects any outgoing movement from an empty ledger', () => {
    expect(() => validateMovement(sale(1), 0)).toThrow('Only 0 on hand');
  });

  it('rejects a second sale after stock hits zero', () => {
    const { movements } = applyMovement([receive(5)], sale(5));
    expect(() => applyMovement(movements, sale(1))).toThrow('Only 0 on hand');
  });

  it('lets a receive restock after hitting zero', () => {
    const first = applyMovement([receive(5)], sale(5));
    const second = applyMovement(first.movements, receive(10));
    expect(second.onHand).toBe(10);
  });

  it('rejects wrong-signed movements', () => {
    expect(() =>
      validateMovement({ type: 'sale', qty_delta: 1 }, 10),
    ).toThrow("'sale' movements must have a negative qty_delta");
    expect(() =>
      validateMovement({ type: 'receive', qty_delta: -1 }, 10),
    ).toThrow("'receive' movements must have a positive qty_delta");
    expect(() =>
      validateMovement({ type: 'receive', qty_delta: 0 }, 10),
    ).toThrow('qty_delta must be a non-zero integer');
  });
});

describe('recordCount', () => {
  it('computes a negative variance for a short count', () => {
    const result = recordCount({ expectedQty: 10, countedQty: 8 });
    expect(result).toEqual({
      variance: -2,
      qtyDelta: -2,
      type: 'count-correction',
      postsMovement: true,
    });
  });

  it('computes a positive variance for an over count', () => {
    expect(recordCount({ expectedQty: 10, countedQty: 12 }).variance).toBe(2);
  });

  it('posts no movement when counted equals expected', () => {
    const result = recordCount({ expectedQty: 10, countedQty: 10 });
    expect(result.variance).toBe(0);
    expect(result.postsMovement).toBe(false);
  });
});
