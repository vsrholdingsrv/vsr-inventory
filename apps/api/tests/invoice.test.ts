import { describe, it, expect } from 'vitest';
import {
  confirmLines,
  createDraft,
  matchInvoiceLines,
  SampleInvoiceProvider,
} from '../src/invoice';

const CATALOG = [
  { id: 'p-water', name: 'Bottled Water 16.9oz', barcode: '085239010202', costCents: 45 },
  { id: 'p-coke', name: 'Coca-Cola 20oz', barcode: '049000050103', costCents: 110 },
  { id: 'p-gatorade', name: 'Gatorade Cool Blue 20oz', barcode: '052000032137', costCents: 120 },
  { id: 'p-doritos', name: 'Doritos Nacho Cheese 2.75oz', barcode: '028400090516', costCents: 135 },
  { id: 'p-snickers', name: 'Snickers Bar 1.86oz', barcode: '040000001017', costCents: 95 },
];

async function sampleDraft() {
  const extracted = await new SampleInvoiceProvider().extract();
  const matched = matchInvoiceLines(extracted.lines, CATALOG);
  return { extracted, matched, draft: createDraft({
    id: 'inv-1',
    storeId: 'store-001',
    supplier: extracted.supplier,
    invoiceNumber: extracted.invoiceNumber,
    lines: matched,
  }) };
}

describe('SampleInvoiceProvider', () => {
  it('returns the Core-Mark sample: 5 catalog lines + 1 unknown line', async () => {
    const extracted = await new SampleInvoiceProvider().extract();
    expect(extracted.supplier).toBe('Core-Mark');
    expect(extracted.lines).toHaveLength(6);
  });
});

describe('matchInvoiceLines', () => {
  it('matches 5 lines by barcode and leaves the unknown line unmatched', async () => {
    const { matched } = await sampleDraft();
    expect(matched.filter((l) => l.status === 'matched')).toHaveLength(5);
    const unmatched = matched.filter((l) => l.status === 'unmatched');
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].name).toMatch(/Mystery Energy Drink/);
    expect(unmatched[0].productId).toBeNull();
  });
});

describe('invoice draft never auto-posts', () => {
  it('a fresh draft posts nothing: no lines confirmed, no movements', async () => {
    const { draft } = await sampleDraft();
    expect(draft.status).toBe('draft');
    expect(draft.lines.every((l) => l.confirmed === false)).toBe(true);
    // The draft carries no movements at all — posting happens only in confirmLines.
    expect('movements' in draft).toBe(false);
  });

  it('confirming zero lines is rejected', async () => {
    const { draft } = await sampleDraft();
    expect(() => confirmLines(draft, [])).toThrow(/zero lines/i);
  });

  it('an unmatched line can never be confirmed', async () => {
    const { draft } = await sampleDraft();
    const unmatched = draft.lines.find((l) => l.status === 'unmatched');
    expect(unmatched).toBeDefined();
    expect(() => confirmLines(draft, [unmatched!.id])).toThrow(/unmatched/i);
  });

  it('confirming matched lines posts exactly one Receive per confirmed line', async () => {
    const { draft } = await sampleDraft();
    const matchedIds = draft.lines
      .filter((l) => l.status === 'matched')
      .slice(0, 2)
      .map((l) => l.id);
    const { movements, draft: updated } = confirmLines(draft, matchedIds);
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({
      storeId: 'store-001',
      productId: 'p-coke',
      qty: 24,
      costCents: 110,
    });
    // The other three matched lines stay unconfirmed: partial confirms are allowed.
    expect(updated.lines.filter((l) => l.confirmed)).toHaveLength(2);
    expect(updated.status).toBe('draft');
  });

  it('confirming every matched line marks the draft confirmed', async () => {
    const { draft } = await sampleDraft();
    const matchedIds = draft.lines
      .filter((l) => l.status === 'matched')
      .map((l) => l.id);
    const { movements, draft: updated } = confirmLines(draft, matchedIds);
    expect(movements).toHaveLength(5);
    expect(updated.status).toBe('confirmed');
  });

  it('re-confirming an already-confirmed line is rejected', async () => {
    const { draft } = await sampleDraft();
    const firstId = draft.lines.find((l) => l.status === 'matched')!.id;
    confirmLines(draft, [firstId]);
    expect(() => confirmLines(draft, [firstId])).toThrow(/already confirmed/i);
  });
});
