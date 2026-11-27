import { describe, it, expect } from 'vitest';
import {
  confirmLines,
  createDraft,
  matchInvoiceLines,
  parseOcrText,
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

describe('parseOcrText — real Red Bull invoice (0.1.5)', () => {
  // OCR text as Tesseract would read the user's 2026-11-26 Red Bull photo:
  // B+K Oil Commerce, invoice 2039427858, 6 lines, 192 units delivered.
  const RED_BULL_OCR = [
    'Red Bull Distribution Company Inc.',
    'P.O. Box 204760',
    'Dallas, TX 75320-4750',
    'B+K Oil Commerce',
    '2500 Union Lake Rd',
    'Commerce Twp, MI 48382',
    'Route: 390A11',
    'Cust#: 3000142426',
    'Invoice: 2039427858',
    '11/26/2026 1:16 PM',
    'ID QTY UNITS DESCRIPTION PRICE DEP DISC SUGAR TOTAL',
    'RB1718 2 48 RED BULL 8.4OZ LS $45.99 $2.40 $8.00 $0.00 $80.78',
    '611269991000',
    'RB249731 1 24 W PEACH 12OZ $58.71 $2.40 $8.00 $0.00 $53.11',
    '611269002706',
    'RB248898 1 24 ICED 12OZ $58.71 $2.40 $8.00 $0.00 $53.11',
    '611269001846',
    'RB253417 1 24 APPLE 12OZ LS $58.71 $2.40 $8.00 $0.00 $53.11',
    '611269002867',
    'RB221027 1 24 COCONUT 12OZ LS $58.71 $2.40 $8.00 $0.00 $53.11',
    '611269321210',
    'RB4817 2 48 SUGARFREE 12OZ LS $58.71 $2.40 $8.00 $0.00 $106.22',
    '611269716467',
    'Units Picked Up (0)',
    'Number of SKU\u2019s 6',
    'Cases Delivered 8',
    'Units Delivered 192',
    'TOTALS',
    'DISCOUNT $64.00',
    'INVOICE $399.44',
    'TOTAL DUE: $0.00',
  ].join('\n');

  it('parses 6 lines with units, barcodes and unit costs — not the Core-Mark sample', () => {
    const inv = parseOcrText(RED_BULL_OCR);
    expect(inv.supplier).toMatch(/Red Bull/i);
    expect(inv.invoiceNumber).toBe('2039427858');
    expect(inv.lines).toHaveLength(6);
    expect(inv.lines.map((l) => l.qty)).toEqual([48, 24, 24, 24, 24, 48]);
    expect(inv.lines.map((l) => l.barcode)).toEqual([
      '611269991000',
      '611269002706',
      '611269001846',
      '611269002867',
      '611269321210',
      '611269716467',
    ]);
    // Unit cost = line total / units: 80.78/48 = $1.68, 53.11/24 = $2.21.
    expect(inv.lines.map((l) => l.unitCostCents)).toEqual([168, 221, 221, 221, 221, 221]);
    expect(inv.lines.reduce((s, l) => s + l.qty, 0)).toBe(192);
    expect(inv.supplier).not.toBe('Core-Mark');
  });

  it('throws instead of returning sample data when no lines are readable', () => {
    expect(() => parseOcrText('Hello world\nnothing here')).toThrow(/No invoice lines/);
  });
});

describe('parseOcrText — messy OCR (0.1.6)', () => {
  it('handles rows split across two lines (description line, then money line)', () => {
    const inv = parseOcrText(
      [
        'Red Bull Distribution Company Inc.',
        'Invoice: 2039427858',
        'RB1718 2 48 RED BULL 8.4OZ LS',
        '45.99 2.40 8.00 0.00 80.78',
        '611269991000',
        'RB4817 2 48 SUGARFREE 12OZ LS',
        '58.71 2.40 8.00 0.00 106.22',
        '611269716467',
      ].join('\n'),
    );
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0].qty).toBe(48);
    expect(inv.lines[0].unitCostCents).toBe(168);
    expect(inv.lines[0].barcode).toBe('611269991000');
    expect(inv.lines[1].unitCostCents).toBe(221);
  });

  it('handles a garbled/missing item code and stray $ signs', () => {
    const inv = parseOcrText(
      [
        'Core-Mark',
        'Invoice: CM-999',
        '2 48 RED BULL 8.4OZ LS $45.99 $2.40 $8.00 $0.00 $80.78',
        '1 24 W PEACH 12OZ $58.71 $2.40 $8.00 $0.00 $53.11',
      ].join('\n'),
    );
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines.map((l) => l.qty)).toEqual([48, 24]);
    expect(inv.lines.map((l) => l.unitCostCents)).toEqual([168, 221]);
  });

  it('still throws on text with no readable rows', () => {
    expect(() => parseOcrText('Red Bull Distribution\nInvoice 123\nThank you')).toThrow(/No invoice lines/);
  });
});
