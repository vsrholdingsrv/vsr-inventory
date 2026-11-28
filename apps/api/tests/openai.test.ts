import { describe, it, expect, vi } from 'vitest';
import { readInvoiceWithOpenAi, parseOpenAiInvoiceJson } from '../src/openai';

const REDBULL_JSON = JSON.stringify({
  supplier: 'Red Bull Distribution Company Inc.',
  invoiceNumber: '2039427858',
  lines: [
    { code: 'RB1718', description: 'RED BULL 8.4OZ LS', units: 48, unitCost: 1.68, total: 80.78, barcode: '611269991000' },
    { code: 'RB249731', description: 'W PEACH 12OZ', units: 24, unitCost: 2.21, total: 53.11, barcode: '611269002706' },
    { code: 'RB248898', description: 'ICED 12OZ', units: 24, unitCost: 2.21, total: 53.11, barcode: '611269001846' },
    { code: 'RB253417', description: 'APPLE 12OZ LS', units: 24, unitCost: 2.21, total: 53.11, barcode: '611269002867' },
    { code: 'RB221027', description: 'COCONUT 12OZ LS', units: 24, unitCost: 2.21, total: 53.11, barcode: '611269321210' },
    { code: 'RB4817', description: 'SUGARFREE 12OZ LS', units: 48, unitCost: 2.21, total: 106.22, barcode: '611269716467' },
  ],
  totals: { unitsDelivered: 192, invoiceTotal: 399.44 },
});

function chatResponse(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
  };
}

describe('OpenAI vision invoice read (0.1.10)', () => {
  it('reads all 6 Red Bull lines exactly', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chatResponse(REDBULL_JSON),
    });
    const read = await readInvoiceWithOpenAi('aGVsbG8=', 'test-key', fetchFn as any);
    expect(read.supplier).toBe('Red Bull Distribution Company Inc.');
    expect(read.invoiceNumber).toBe('2039427858');
    expect(read.lines).toHaveLength(6);
    expect(read.lines.map((l) => l.qty)).toEqual([48, 24, 24, 24, 24, 48]);
    expect(read.lines.map((l) => l.unitCostCents)).toEqual([168, 221, 221, 221, 221, 221]);
    expect(read.lines.map((l) => l.barcode)).toEqual([
      '611269991000',
      '611269002706',
      '611269001846',
      '611269002867',
      '611269321210',
      '611269716467',
    ]);
    expect(read.expectedTotalCents).toBe(39944);
    expect(read.expectedUnits).toBe(192);
    // The request goes to chat completions with the photo inline.
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('api.openai.com/v1/chat/completions');
    expect((init as any).headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse((init as any).body);
    expect(body.model).toBe('gpt-4o');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('derives unit cost from the total when the model omits it', () => {
    const read = parseOpenAiInvoiceJson(
      JSON.stringify({
        supplier: 'Core-Mark',
        invoiceNumber: 'CM-1',
        lines: [{ description: 'Coca-Cola 20oz', units: 24, total: 26.4, barcode: null }],
        totals: { unitsDelivered: 24, invoiceTotal: 26.4 },
      }),
    );
    expect(read.lines).toHaveLength(1);
    expect(read.lines[0].unitCostCents).toBe(110);
  });

  it('drops lines with missing or absurd quantities instead of inventing them', () => {
    const read = parseOpenAiInvoiceJson(
      JSON.stringify({
        supplier: 'X',
        invoiceNumber: '',
        lines: [
          { description: 'No qty here', units: null, total: 10 },
          { description: 'Huge', units: 5000, total: 10 },
          { description: 'Good line', units: 12, total: 12, barcode: '123456789012' },
        ],
        totals: { unitsDelivered: null, invoiceTotal: null },
      }),
    );
    expect(read.lines).toHaveLength(1);
    expect(read.lines[0].name).toBe('Good line');
  });

  it('throws a clear error on a bad API key', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Incorrect API key',
    });
    await expect(
      readInvoiceWithOpenAi('aGVsbG8=', 'bad-key', fetchFn as any),
    ).rejects.toThrow(/rejected the API key/);
  });

  it('throws on a non-JSON response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => chatResponse('not json at all'),
    });
    await expect(
      readInvoiceWithOpenAi('aGVsbG8=', 'test-key', fetchFn as any),
    ).rejects.toThrow(/not valid JSON/);
  });
});
