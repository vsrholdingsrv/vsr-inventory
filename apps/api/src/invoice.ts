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
  // OCR garbage ("ae Ra JN: 0") is worse than no supplier: only trust a
  // supplier line that contains a real word (5+ letters).
  const supplierCandidate = supplierLine.replace(/\s+/g, ' ').trim();
  const supplier = /[A-Za-z]{5,}/.test(supplierCandidate)
    ? supplierCandidate
    : 'Unknown supplier';
  const invoiceMatch = text.match(/invoice[:\s#]*([A-Za-z0-9][A-Za-z0-9-]{4,})/i);
  const invoiceNumber =
    invoiceMatch && /\d{5,}/.test(invoiceMatch[1]) ? invoiceMatch[1] : '';

  const SKIP = /^(totals?|discount|invoice|deposit|tax|total due|units picked|number of sku|cases delivered|units delivered|id\s+qty|route:|load sheet|salesman:|cust#|terms:|po#|for billing|your signature|printed signature)/i;

  const lines: InvoiceLineInput[] = [];
  // Tesseract often splits one table row across two text lines
  // ("RB1718 2 48 RED BULL 8.4OZ LS" / "45.99 2.40 8.00 0.00 80.78"), so
  // accumulate lines into a buffer and flush it as one logical row when a
  // money value appears. Headers and bare barcodes flush on their own.
  const logical: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) logical.push(buf.trim());
    buf = '';
  };
  for (const line of rawLines) {
    if (/^\d{12}$/.test(line)) {
      flush();
      logical.push(line);
      continue;
    }
    if (SKIP.test(line) || /invoice/i.test(line) || /distribution|company/i.test(line)) {
      flush();
      logical.push(line);
      continue;
    }
    buf = buf ? `${buf} ${line}` : line;
    if (/\d+\.\d{2}/.test(line)) flush();
  }
  flush();

  for (let i = 0; i < logical.length; i++) {
    const line = logical[i];
    if (SKIP.test(line)) continue;
    // Totals/summary block: these phrases never appear in a real item row,
    // wherever they sit in a merged line — drop the whole line.
    if (/number of sku|units picked|units delivered|cases delivered|total due|check:|c\. applied|roa:/i.test(line)) continue;
    // A bare 12-digit line is a barcode for the previous item, not a line.
    if (/^\d{12}$/.test(line)) continue;

    // Tolerant row parse: last money value is the line total, the first two
    // integers are cases + UNITS (stock moves in units), and everything
    // between them and the money tail is the description. The item code is
    // optional — OCR often drops or garbles it.
    //
    // Sanity guards (a folded/angled photo misreads digits badly, e.g. 48
    // as "4s" and $58.71 as $68.71): a row is only trusted if it has at
    // least 2 money values, no integer longer than 4 digits in the head
    // (a barcode fragment leaking into the quantity), qty 1–999, and a
    // unit cost between $0.05 and $200. Rows failing these are dropped —
    // a wrong draft line is worse than no draft line, and the draft is
    // review-only either way.
    const moneys = [...line.matchAll(/(\d{1,3}(?:,\d{3})*\.\d{2})/g)].map((m) =>
      Number(m[1].replace(/,/g, '')),
    );
    if (moneys.length < 2) continue;
    const total = moneys[moneys.length - 1];
    // Head = everything before the first money value.
    const firstMoneyIdx = line.search(/\d{1,3}(?:,\d{3})*\.\d{2}/);
    const head = line.slice(0, firstMoneyIdx).trim();
    const intTokens = [...head.matchAll(/\b(\d+)\b/g)].map((m) => m[1]);
    if (intTokens.some((t) => t.length > 4)) continue;
    const ints = intTokens.map(Number);
    if (ints.length === 0 || !Number.isFinite(total) || total <= 0) continue;
    const qty = ints.length >= 2 ? ints[1] : ints[0];
    if (qty < 1 || qty > 999) continue;
    const unitCostCents = Math.round((total * 100) / qty);
    if (unitCostCents < 5 || unitCostCents > 20000) continue;
    // Description: head minus a leading item code and the two qty integers.
    let desc = head
      .replace(/^[A-Za-z]{1,4}[\d-]{2,}\s+/, '')
      .replace(/\b\d+\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    desc = cleanDescription(desc);
    if (!/[A-Za-z]{3,}/.test(desc)) continue;
    // Barcode: a 12-digit token in this line, or the bare line after it.
    const inLineBarcode = line.match(/\b(\d{12})\b/);
    const barcode =
      inLineBarcode?.[1] ??
      (/^\d{12}$/.test(logical[i + 1] ?? '') ? logical[i + 1] : undefined);
    // A trusted row must carry an item code (RB1718), a barcode, or a full
    // distributor money row (price + deposit + discount + sugar + total).
    // Without any anchor the numbers are unanchored OCR noise — the junk
    // line in the user's screenshot ("oo HE A Tamme . Ti Sa an LL", qty 8
    // @ $58.25, only 2 money values) passed every numeric guard and still
    // was not a real invoice line.
    const hasCode = /[A-Za-z]{1,4}\d{2,}/.test(head);
    if (!hasCode && !barcode && moneys.length < 4) continue;
    lines.push({
      name: desc,
      barcode,
      qty,
      unitCostCents,
    });
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

export interface Reconciliation {
  expectedTotalCents: number | null;
  linesTotalCents: number;
  expectedUnits: number | null;
  linesUnits: number;
  matches: boolean;
}

/**
 * Cross-check parsed lines against the totals printed on the invoice
 * itself (INVOICE $399.44, Units Delivered 192). A draft whose lines do
 * not add up to the printed totals was misread — the user must see that
 * before confirming anything, not after posting it to the ledger.
 */
export function reconcileInvoice(
  text: string,
  lines: InvoiceLineInput[],
): Reconciliation {
  const totalMatch = text.match(/invoice\s+\$?\s*([\d,]+\.\d{2})/i);
  const expectedTotalCents = totalMatch
    ? Math.round(Number(totalMatch[1].replace(/,/g, '')) * 100)
    : null;
  const unitsMatch = text.match(/units delivered\s+(\d+)/i);
  const expectedUnits = unitsMatch ? Number(unitsMatch[1]) : null;
  const linesTotalCents = lines.reduce((s, l) => s + l.qty * l.unitCostCents, 0);
  const linesUnits = lines.reduce((s, l) => s + l.qty, 0);
  const totalOk =
    expectedTotalCents === null ||
    Math.abs(linesTotalCents - expectedTotalCents) <= 200;
  const unitsOk = expectedUnits === null || linesUnits === expectedUnits;
  return {
    expectedTotalCents,
    linesTotalCents,
    expectedUnits,
    linesUnits,
    matches: totalOk && unitsOk,
  };
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
