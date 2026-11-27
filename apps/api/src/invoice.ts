/**
 * invoice.ts — supplier-invoice OCR intake.
 *
 * *** DRAFT-ONLY — NEVER AUTO-POSTS ***
 * An OCR result becomes an invoice_scans row in status 'draft' with one
 * invoice_lines row per extracted line. Nothing touches the inventory
 * ledger at scan time. Only an explicit human confirm call
 * (POST /invoices/:id/confirm) turns confirmed + matched lines into
 * 'receive' movements — and only the lines the human confirmed.
 * Unmatched lines can never be confirmed; confirming zero lines is rejected.
 */

export interface InvoiceLineInput {
  name: string;
  barcode?: string;
  qty: number;
  unitCostCents: number;
}

export interface ExtractedInvoice {
  supplier: string;
  invoiceNumber: string;
  lines: InvoiceLineInput[];
}

/** Any OCR engine behind invoice intake must satisfy this shape. */
export interface OcrProvider {
  extract(image: Buffer | string): Promise<ExtractedInvoice>;
}

/**
 * Default provider until a real OCR engine is wired in: refuses to guess.
 * Callers surface the error and ask for a manual entry instead.
 */
export class StubOcrProvider implements OcrProvider {
  async extract(_image?: Buffer | string): Promise<ExtractedInvoice> {
    throw new Error(
      'No OCR provider configured (OCR_PROVIDER=stub). ' +
        'Wire in a real OCR engine or use OCR_PROVIDER=sample for the demo invoice.',
    );
  }
}

/**
 * Demo provider: returns a fixed Core-Mark sample invoice matching 5 of the
 * seeded demo SKUs by barcode, plus one unknown line to exercise the
 * unmatched path. No image is read; the argument is ignored.
 */
export class SampleInvoiceProvider implements OcrProvider {
  async extract(_image?: Buffer | string): Promise<ExtractedInvoice> {
    return {
      supplier: 'Core-Mark',
      invoiceNumber: 'CM-2026-1125-0042',
      lines: [
        { name: 'Coca-Cola 20oz', barcode: '049000050103', qty: 24, unitCostCents: 110 },
        { name: 'Gatorade Cool Blue 20oz', barcode: '052000032137', qty: 24, unitCostCents: 120 },
        { name: 'Doritos Nacho Cheese 2.75oz', barcode: '028400090516', qty: 12, unitCostCents: 135 },
        { name: 'Snickers Bar 1.86oz', barcode: '040000001017', qty: 24, unitCostCents: 95 },
        { name: 'Bottled Water 16.9oz', barcode: '085239010202', qty: 48, unitCostCents: 45 },
        // Unknown to the catalog on purpose: exercises the unmatched path.
        { name: 'Mystery Energy Drink 16oz', barcode: '099999999999', qty: 12, unitCostCents: 150 },
      ],
    };
  }
}

/**
 * Parse OCR text (from Tesseract.js in the browser) into an invoice.
 * The browser reads the photo and sends the *text* — the server never
 * guesses from a photo it cannot read, and never falls back to the demo
 * invoice: 0 parsed lines is an error, not sample data.
 *
 * Handles the distributor table format seen on real invoices, e.g. Red Bull:
 *   RB1718  2  48  RED BULL 8.4OZ LS  $45.99  $2.40  $8.00  $0.00  $80.78
 *   611269991000
 * Columns are code, cases, UNITS, description, price/case, deposit, discount,
 * sugar, line TOTAL. Stock moves in units, so qty = UNITS and
 * unit cost = line total / units (discount/deposit already in the total).
 * The 12-digit barcode usually sits on the line under the description.
 */
export function parseOcrText(text: string): ExtractedInvoice {
  const rawLines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\$/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const supplierLine =
    rawLines.find((l) => /distribution|company/i.test(l) && l.length < 80) ??
    rawLines[0] ??
    'Unknown supplier';
  const supplier = supplierLine.replace(/\s+/g, ' ').trim();
  const invoiceMatch = text.match(/invoice[:\s#]*([A-Za-z0-9][A-Za-z0-9-]{3,})/i);
  const invoiceNumber = invoiceMatch ? invoiceMatch[1] : '';

  const SKIP = /^(totals?|discount|invoice|deposit|tax|total due|units picked|number of sku|cases delivered|units delivered|id\s+qty|route:|load sheet|salesman:|cust#|terms:|po#|for billing|your signature|printed signature)/i;

  const lines: InvoiceLineInput[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (SKIP.test(line)) continue;
    // A bare 12-digit line is a barcode for the previous item, not a line.
    if (/^\d{12}$/.test(line)) continue;

    const m = line.match(
      /^([A-Za-z]{1,3}\d{3,})\s+(\d+)\s+(\d+)\s+(.+?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/,
    );
    if (m) {
      const units = Number(m[3]);
      const total = Number(m[9].replace(/,/g, ''));
      if (units <= 0 || !Number.isFinite(total)) continue;
      const barcode =
        /^\d{12}$/.test(rawLines[i + 1] ?? '') ? rawLines[i + 1] : undefined;
      lines.push({
        name: cleanDescription(m[4]),
        barcode,
        qty: units,
        unitCostCents: Math.round((total * 100) / units),
      });
      continue;
    }
    // Generic fallback: "DESCRIPTION  qty  $total" — total is the last number.
    const g = line.match(/^([A-Za-z][A-Za-z0-9 .&/-]{2,})\s+(\d+)\s+\$?([\d,]+\.\d{2})\s*$/);
    if (g && !/^\d+$/.test(g[1])) {
      const qty = Number(g[2]);
      const total = Number(g[3].replace(/,/g, ''));
      if (qty > 0 && Number.isFinite(total)) {
        lines.push({
          name: cleanDescription(g[1]),
          qty,
          unitCostCents: Math.round((total * 100) / qty),
        });
      }
    }
  }

  if (lines.length === 0) {
    throw new Error(
      'No invoice lines could be read from this photo. Try a closer, well-lit shot of the full invoice, or enter the lines manually.',
    );
  }
  // De-dupe by barcode, keeping the first occurrence.
  const seen = new Set<string>();
  const deduped = lines.filter((l) => {
    if (!l.barcode) return true;
    if (seen.has(l.barcode)) return false;
    seen.add(l.barcode);
    return true;
  });
  return { supplier, invoiceNumber, lines: deduped };
}

function cleanDescription(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 .&/-]/g, '')
    .trim();
}

/** OCR provider that parses text the browser already read (Tesseract.js). */
export class TextOcrProvider implements OcrProvider {
  async extract(text: Buffer | string): Promise<ExtractedInvoice> {
    if (typeof text !== 'string' || text.trim().length < 20) {
      throw new Error('No readable invoice text was sent with the scan.');
    }
    return parseOcrText(text);
  }
}

export interface CatalogProduct {
  id: string;
  name: string;
  barcode: string;
  costCents: number;
}

export type LineMatchStatus = 'matched' | 'unmatched';

export interface MatchedInvoiceLine extends InvoiceLineInput {
  status: LineMatchStatus;
  productId: string | null;
  matchReason: string;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Match OCR lines to the catalog.
 * 1. Exact barcode match wins.
 * 2. Otherwise a fuzzy name match: every significant word of the shorter
 *    name must appear in the longer one (e.g. "Coca-Cola 20oz" ~ "Coca-Cola").
 * Anything else is 'unmatched' and can never be confirmed or posted.
 */
export function matchInvoiceLines(
  lines: ReadonlyArray<InvoiceLineInput>,
  catalog: ReadonlyArray<CatalogProduct>,
): MatchedInvoiceLine[] {
  const byBarcode = new Map(catalog.map((p) => [p.barcode, p]));

  return lines.map((line) => {
    if (line.barcode) {
      const hit = byBarcode.get(line.barcode);
      if (hit) {
        return { ...line, status: 'matched' as const, productId: hit.id, matchReason: `barcode ${line.barcode}` };
      }
    }
    const lineWords = normalizeName(line.name)
      .split(' ')
      .filter((w) => w.length > 2 && !/^\d+(\.\d+)?(oz|ct|lb|pk)?$/.test(w));
    const nameHit = catalog.find((p) => {
      const productWords = normalizeName(p.name).split(' ');
      const shorter = lineWords.length <= productWords.length ? lineWords : productWords;
      const longer = lineWords.length <= productWords.length ? productWords : lineWords;
      return shorter.length > 0 && shorter.every((w) => longer.includes(w));
    });
    if (nameHit) {
      return { ...line, status: 'matched' as const, productId: nameHit.id, matchReason: `name fuzzy match: ${nameHit.name}` };
    }
    return {
      ...line,
      status: 'unmatched' as const,
      productId: null,
      matchReason: 'No catalog product matches barcode or name',
    };
  });
}

export interface DraftLine extends MatchedInvoiceLine {
  id: string;
  confirmed: boolean;
}

export interface InvoiceDraft {
  id: string;
  storeId: string;
  supplier: string;
  invoiceNumber: string;
  status: 'draft' | 'confirmed' | 'void';
  lines: DraftLine[];
}

/** Build a draft from matched lines. Posts nothing to the ledger. */
export function createDraft(
  input: {
    id: string;
    storeId: string;
    supplier: string;
    invoiceNumber: string;
    lines: MatchedInvoiceLine[];
  },
): InvoiceDraft {
  return {
    id: input.id,
    storeId: input.storeId,
    supplier: input.supplier,
    invoiceNumber: input.invoiceNumber,
    status: 'draft',
    lines: input.lines.map((line, i) => ({
      ...line,
      id: `${input.id}-line-${i + 1}`,
      confirmed: false,
    })),
  };
}

export interface ReceiveMovementInput {
  storeId: string;
  productId: string;
  qty: number;
  costCents: number;
  note: string;
}

export interface ConfirmResult {
  draft: InvoiceDraft;
  /** Receive movements to post — one per confirmed line, nothing else. */
  movements: ReceiveMovementInput[];
}

/**
 * Confirm a subset of a draft's lines.
 *
 * - Only lines in the draft can be confirmed (unknown ids are rejected).
 * - Unmatched lines can never be confirmed.
 * - Zero confirmed lines is rejected — confirming nothing posts nothing.
 * - Confirming is idempotent per line only in the sense that re-confirming
 *   an already-confirmed line is rejected; a second confirm call with new
 *   line ids posts only those new lines.
 * Returns the updated draft plus the exact Receive movements to post.
 * The caller persists both inside one transaction.
 */
export function confirmLines(
  draft: InvoiceDraft,
  lineIds: ReadonlyArray<string>,
): ConfirmResult {
  if (draft.status !== 'draft') {
    throw new Error(`Invoice ${draft.id} is ${draft.status}, not a draft`);
  }
  if (lineIds.length === 0) {
    throw new Error('No lines selected: confirming zero lines posts nothing');
  }

  const byId = new Map(draft.lines.map((l) => [l.id, l]));
  const movements: ReceiveMovementInput[] = [];

  for (const lineId of lineIds) {
    const line = byId.get(lineId);
    if (!line) {
      throw new Error(`Line ${lineId} is not part of invoice ${draft.id}`);
    }
    if (line.confirmed) {
      throw new Error(`Line ${lineId} (${line.name}) was already confirmed`);
    }
    if (line.status !== 'matched' || !line.productId) {
      throw new Error(
        `Line ${lineId} (${line.name}) is unmatched and cannot be confirmed`,
      );
    }
    line.confirmed = true;
    movements.push({
      storeId: draft.storeId,
      productId: line.productId,
      qty: line.qty,
      costCents: line.unitCostCents,
      note: `Invoice ${draft.invoiceNumber} (${draft.supplier})`,
    });
  }

  if (movements.length === 0) {
    throw new Error('No lines confirmed: confirming zero lines posts nothing');
  }

  const updated: InvoiceDraft = {
    ...draft,
    status: draft.lines.every((l) => l.confirmed || l.status === 'unmatched')
      ? 'confirmed'
      : 'draft',
    lines: draft.lines.map((l) => ({ ...l })),
  };
  return { draft: updated, movements };
}
