import { describe, it, expect } from 'vitest';
import {
  classifyPriceBook,
  CommanderTransaction,
  importPriceBook,
  ingestVerifoneTransaction,
  SIMULATED_PRICE_BOOK,
  SimulatedCommanderConnector,
} from '../src/commander';

// The 12 seeded demo SKUs, by barcode.
const DEMO_CATALOG = [
  { upc: '085239010202' },
  { upc: '049000050103' },
  { upc: '052000032137' },
  { upc: '070847001031' },
  { upc: '070738500112' },
  { upc: '028400064834' },
  { upc: '028400090516' },
  { upc: '040000001017' },
  { upc: '034000000106' },
  { upc: '012000000927' },
  { upc: '041220110202' },
  { upc: '028100101010' },
];

function tx(overrides: Partial<CommanderTransaction> = {}): CommanderTransaction {
  return {
    transactionId: 'TX-1',
    storeId: 'store-001',
    registerId: 'REG-1',
    lines: [{ upc: '049000050103', qty: 2, priceCents: 199 }],
    totalCents: 398,
    ...overrides,
  };
}

describe('Commander Pull classification', () => {
  it('simulated price book has 20 items', () => {
    expect(SIMULATED_PRICE_BOOK).toHaveLength(20);
  });

  it('classifies 16 new, 3 duplicate, 1 inactive against the demo catalog', () => {
    const classified = classifyPriceBook(SIMULATED_PRICE_BOOK, DEMO_CATALOG);
    const counts = classified.reduce<Record<string, number>>((acc, c) => {
      acc[c.classification] = (acc[c.classification] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ new: 16, duplicate: 3, inactive: 1 });
  });

  it('marks the discontinued jerky inactive, never new', () => {
    const classified = classifyPriceBook(SIMULATED_PRICE_BOOK, DEMO_CATALOG);
    const jerky = classified.find((c) => c.item.upc === '098765432109');
    expect(jerky?.classification).toBe('inactive');
  });
});

describe('importPriceBook (add-new-only)', () => {
  it('adds only the 16 new items; updated is always 0; duplicates/inactive skipped', () => {
    const result = importPriceBook(SIMULATED_PRICE_BOOK, DEMO_CATALOG);
    expect(result.added).toHaveLength(16);
    expect(result.updated).toBe(0);
    expect(result.skipped).toHaveLength(4);
    expect(result.added.map((i) => i.upc)).not.toContain('049000050103');
    expect(result.added.map((i) => i.upc)).not.toContain('098765432109');
  });

  it('adds nothing when the whole book is already in the catalog', () => {
    const fullCatalog = SIMULATED_PRICE_BOOK.filter((i) => i.active).map((i) => ({
      upc: i.upc,
    }));
    const result = importPriceBook(SIMULATED_PRICE_BOOK, fullCatalog);
    expect(result.added).toHaveLength(0);
    expect(result.skipped).toHaveLength(20);
  });
});

describe('ingestVerifoneTransaction', () => {
  const onHand = new Map([['049000050103', 5]]);

  it('posts lines that are in stock', () => {
    const result = ingestVerifoneTransaction(tx(), {
      onHandByUpc: onHand,
      seenTransactionIds: new Set(),
    });
    expect(result.accepted).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.postedLines).toEqual([
      { upc: '049000050103', qty: 2, movementType: 'sale' },
    ]);
    expect(result.unmatchedLines).toHaveLength(0);
  });

  it('de-dupes by transaction_id: a replay posts nothing', () => {
    const seen = new Set(['TX-1']);
    const result = ingestVerifoneTransaction(tx(), {
      onHandByUpc: onHand,
      seenTransactionIds: seen,
    });
    expect(result.accepted).toBe(false);
    expect(result.duplicate).toBe(true);
    expect(result.postedLines).toHaveLength(0);
  });

  it('blocks a line that exceeds on-hand as insufficient_stock, never negative', () => {
    const result = ingestVerifoneTransaction(
      tx({ lines: [{ upc: '049000050103', qty: 6, priceCents: 199 }] }),
      { onHandByUpc: onHand, seenTransactionIds: new Set() },
    );
    expect(result.accepted).toBe(true);
    expect(result.postedLines).toHaveLength(0);
    expect(result.unmatchedLines).toHaveLength(1);
    expect(result.unmatchedLines[0].reason).toBe('insufficient_stock');
    expect(result.unmatchedLines[0].detail).toMatch(/Only 5 on hand/);
  });

  it('marks an unknown UPC as unmatched', () => {
    const result = ingestVerifoneTransaction(
      tx({ lines: [{ upc: '000000000000', qty: 1, priceCents: 100 }] }),
      { onHandByUpc: onHand, seenTransactionIds: new Set() },
    );
    expect(result.postedLines).toHaveLength(0);
    expect(result.unmatchedLines[0].reason).toBe('unmatched');
  });

  it('posts the in-stock lines and blocks only the short line in a mixed basket', () => {
    const result = ingestVerifoneTransaction(
      tx({
        lines: [
          { upc: '049000050103', qty: 2, priceCents: 199 },
          { upc: '049000050103', qty: 99, priceCents: 199 },
        ],
      }),
      { onHandByUpc: onHand, seenTransactionIds: new Set() },
    );
    expect(result.postedLines).toHaveLength(1);
    expect(result.unmatchedLines).toHaveLength(1);
  });

  it('shares on-hand across duplicate UPC lines in one transaction: 5 + 5 against 8 posts only 5', () => {
    // Regression: each line used to be checked against the starting
    // on-hand, so 5 + 5 against 8 both "passed" and stock went to -2.
    const result = ingestVerifoneTransaction(
      tx({
        lines: [
          { upc: '049000050103', qty: 5, priceCents: 199 },
          { upc: '049000050103', qty: 5, priceCents: 199 },
        ],
      }),
      { onHandByUpc: new Map([['049000050103', 8]]), seenTransactionIds: new Set() },
    );
    expect(result.postedLines).toHaveLength(1);
    expect(result.postedLines[0].qty).toBe(5);
    expect(result.unmatchedLines).toHaveLength(1);
    expect(result.unmatchedLines[0].reason).toBe('insufficient_stock');
    expect(result.unmatchedLines[0].detail).toMatch(/Only 3 on hand/);
  });

  it('posts two lines for the same UPC when their combined qty fits on-hand', () => {
    const result = ingestVerifoneTransaction(
      tx({
        lines: [
          { upc: '049000050103', qty: 3, priceCents: 199 },
          { upc: '049000050103', qty: 2, priceCents: 199 },
        ],
      }),
      { onHandByUpc: onHand, seenTransactionIds: new Set() },
    );
    expect(result.postedLines).toHaveLength(2);
    expect(result.unmatchedLines).toHaveLength(0);
  });
});

describe('SimulatedCommanderConnector', () => {
  it('pulls the 20-item simulated price book', async () => {
    const connector = new SimulatedCommanderConnector();
    const items = await connector.pullPriceBook();
    expect(items).toHaveLength(20);
  });

  it('de-dupes a replayed transaction on the second ingest', async () => {
    const connector = new SimulatedCommanderConnector(() =>
      new Map([['049000050103', 5]]),
    );
    const first = await connector.ingestTransaction(tx());
    const second = await connector.ingestTransaction(tx());
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.duplicate).toBe(true);
  });
});
