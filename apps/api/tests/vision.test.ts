import { describe, it, expect, vi } from 'vitest';
import { readInvoiceWithVision, groupVisionWords } from '../src/vision';
import { parseOcrRows, reconcileInvoice } from '../src/invoice';

// Build a Vision-shaped response from exact invoice text: one word per
// token, laid out in rows, the way DOCUMENT_TEXT_DETECTION returns them.
function visionResponse(rows: string[][]) {
  const blocks: any[] = [];
  let y = 100;
  const allText: string[] = [];
  for (const row of rows) {
    let x = 50;
    const words: any[] = [];
    for (const token of row) {
      const w = token.length * 9;
      words.push({
        boundingBox: {
          vertices: [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + 22 },
            { x, y: y + 22 },
          ],
        },
        symbols: token.split('').map((ch) => ({ text: ch })),
      });
      x += w + 14;
    }
    allText.push(row.join(' '));
    blocks.push({ paragraphs: [{ words }] });
    y += 60;
  }
  return {
    responses: [
      {
        fullTextAnnotation: {
          text: allText.join('\n'),
          pages: [{ width: 1290, height: 1720, blocks }],
        },
      },
    ],
  };
}

const ROWS = [
  ['Red', 'Bull', 'Distribution', 'Company', 'Inc.'],
  ['Invoice:', '2039427858'],
  ['RB1718', '2', '48', 'RED', 'BULL', '8.4OZ', 'LS', '$45.99', '$2.40', '$8.00', '$0.00', '$80.78'],
  ['611269991000'],
  ['RB249731', '1', '24', 'W', 'PEACH', '12OZ', '$58.71', '$2.40', '$8.00', '$0.00', '$53.11'],
  ['611269002706'],
  ['RB248898', '1', '24', 'ICED', '12OZ', '$58.71', '$2.40', '$8.00', '$0.00', '$53.11'],
  ['611269001846'],
  ['RB253417', '1', '24', 'APPLE', '12OZ', 'LS', '$58.71', '$2.40', '$8.00', '$0.00', '$53.11'],
  ['611269002867'],
  ['RB221027', '1', '24', 'COCONUT', '12OZ', 'LS', '$58.71', '$2.40', '$8.00', '$0.00', '$53.11'],
  ['611269321210'],
  ['RB4817', '2', '48', 'SUGARFREE', '12OZ', 'LS', '$58.71', '$2.40', '$8.00', '$0.00', '$106.22'],
  ['611269716467'],
  ['Units', 'Delivered', '192'],
  ['INVOICE', '$399.44'],
];

describe('Google Vision invoice read (0.1.10)', () => {
  it('reads all 6 Red Bull lines exactly', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => visionResponse(ROWS),
    });
    const read = await readInvoiceWithVision('aGVsbG8=', 'test-key', fetchFn as any);
    expect(read.text).toContain('2039427858');
    const lines = parseOcrRows(read.rows);
    expect(lines).toHaveLength(6);
    expect(lines.map((l) => l.qty)).toEqual([48, 24, 24, 24, 24, 48]);
    expect(lines.map((l) => l.unitCostCents)).toEqual([168, 221, 221, 221, 221, 221]);
    expect(lines.map((l) => l.barcode)).toEqual([
      '611269991000',
      '611269002706',
      '611269001846',
      '611269002867',
      '611269321210',
      '611269716467',
    ]);
    const r = reconcileInvoice(read.text, lines);
    expect(r.linesUnits).toBe(192);
    expect(r.matches).toBe(true);
  });

  it('throws a clear error when Vision fails', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(readInvoiceWithVision('aGVsbG8=', 'bad-key', fetchFn as any)).rejects.toThrow(
      /Vision request failed/,
    );
  });

  it('groups words into rows by vertical band', () => {
    const rows = groupVisionWords(
      [
        { text: 'RB1718', left: 50, yc: 100 },
        { text: '48', left: 150, yc: 102 },
        { text: '$80.78', left: 400, yc: 99 },
        { text: 'RB249731', left: 50, yc: 160 },
        { text: '24', left: 150, yc: 161 },
      ],
      1720,
    );
    expect(rows).toEqual(['RB1718 48 $80.78', 'RB249731 24']);
  });
});
