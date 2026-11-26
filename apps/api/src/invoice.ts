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

export function ocrProviderFromEnv(): OcrProvider {
  return process.env.OCR_PROVIDER === 'stub'
    ? new StubOcrProvider()
    : new SampleInvoiceProvider();
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
