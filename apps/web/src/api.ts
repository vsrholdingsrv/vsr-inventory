/**
 * Typed fetch client for the VSR Inventory backend (apps/api).
 *
 * Every API call in the UI goes through this module — components never call
 * fetch() directly. The backend base URL comes from VITE_API_URL and
 * defaults to http://localhost:4000 for local development.
 *
 * ADAPTER NOTE: the backend speaks snake_case DB rows (cost_cents,
 * on_hand, par_qty, store_id, …) and the UI speaks camelCase. All mapping
 * lives here, in one place. Backend contract (verified against
 * apps/api/src/routes/*):
 *   GET  /api/products[?storeId=]            catalog, per-store on-hand when storeId given
 *   POST /api/products/restock-all           { storeId? } -> { storeId, restockedCount, products }
 *   POST /api/movements                      { storeId, productId, type, qty, costCents?, note? }
 *   POST /api/movements/cycle-counts         { storeId, productId, countedQty, expectedQty? }
 *   GET  /api/dashboard/summary[?storeId=]   totals + low stock + recent movements
 *   GET  /api/commander/price-book           { source, count, items: [{ upc, name, category, costCents, priceCents, active }] }
 *   POST /api/commander/price-book/import    { storeId? } -> { added, addedCount, updated, skipped, skippedCount }
 *   POST /api/commander/transactions         Commander-style sale ingest (de-dupe by transactionId)
 *   POST /api/invoices/scan                  { storeId, imageBase64? } -> draft (never auto-posts)
 *   GET  /api/invoices/sample[?storeId=]     Core-Mark sample invoice as a draft
 *   POST /api/invoices/:id/confirm           { lineIds } -> confirmed lines post Receive movements
 *   GET  /api/stores                         [{ id, code, name, city, state, address, is_home, … }]
 *   PATCH /api/stores/:id                    name/city/state/address/is_home only
 *   POST /api/stores/:id/rollout             { margins[] | defaultMarginPct } — per-product margins
 *
 * The backend has no per-product location / supplier / reorder-point
 * columns yet, so those UI fields map to '' / 0 until the schema grows
 * them. The live Commander POS feed is SIMULATED in the backend
 * (see CommanderPull). Nothing here claims a real Verifone connection.
 */

export const API_BASE_URL: string =
  import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

/* ------------------------------------------------------------------ types */

export interface Product {
  id: string;
  sku: string;
  name: string;
  barcode: string;
  onHand: number;
  par: number;
  reorderPoint: number;
  cost: number;
  price: number;
  location: string;
  supplier: string;
  storeId: string;
  /** True when the product still needs cost / supplier / reorder / par / location filled in. */
  needsSetup?: boolean;
}

export interface Store {
  id: string;
  name: string;
  address?: string;
  city?: string;
  /** Verifone Commander model/version, when known. */
  commanderModel?: string;
  /** Margin % applied on top of cost to preview the selling price. */
  marginPct: number;
  status: 'live' | 'pilot' | 'rollout' | 'planned';
}

export type MovementType = 'sale' | 'receive' | 'adjustment' | 'count' | 'return';

export interface Movement {
  id: string;
  type: MovementType;
  barcode: string;
  productName: string;
  qty: number;
  /** Signed quantity change: sales are negative, receives positive. */
  delta: number;
  cost: number;
  price: number;
  reason?: string;
  storeId: string;
  createdAt: string;
}

export type PriceBookStatus = 'new' | 'duplicate' | 'inactive';

export interface PriceBookItem {
  barcode: string;
  name: string;
  price: number;
  cost: number;
  status: PriceBookStatus;
  /** Existing product id when status is duplicate / inactive. */
  existingProductId?: string;
  department?: string;
}

export interface ImportReport {
  added: number;
  updated: number;
  skipped: number;
  needsSetup: PriceBookItem[];
}

export interface InvoiceLine {
  id: string;
  barcode: string;
  description: string;
  qty: number;
  cost: number;
  supplier: string;
  /** Product matched in the catalog, if any. */
  matchedProductId?: string;
  matchedProductName?: string;
  confirmed: boolean;
}

export interface InvoiceDraft {
  id: string;
  supplier: string;
  invoiceNumber?: string;
  lines: InvoiceLine[];
  createdAt: string;
}

export interface OverviewTotals {
  totalUnits: number;
  totalCostValue: number;
  totalRetailValue: number;
  lowStockCount: number;
  outOfStockCount: number;
}

export interface SaleResult {
  movement: Movement;
  product: Product;
  transactionTotal: number;
}

/* ------------------------------------------------------- backend row types */

interface ProductRow {
  id: string;
  barcode: string;
  name: string;
  category?: string | null;
  cost_cents: number;
  price_cents: number;
  margin_pct?: number | string | null;
  par_qty?: number | null;
  on_hand?: number | null;
}

interface StoreRow {
  id: string;
  code: string;
  name: string;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  is_home?: boolean | null;
  /** Most common per-product margin at this store (NUMERIC comes back as a string). */
  margin_pct?: number | string | null;
}

interface MovementRow {
  id: string;
  store_id: string;
  product_id: string;
  type: string;
  qty_delta: number;
  cost_cents?: number | null;
  note?: string | null;
  created_at: string;
}

interface CommanderPriceBookRow {
  upc: string;
  name: string;
  category: string;
  costCents: number;
  priceCents: number;
  active: boolean;
}

/* -------------------------------------------------------------- plumbing */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      // Keep the HTTP status text when the body is not JSON.
    }
    throw new Error(`API ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

const centsToDollars = (cents: number | null | undefined): number =>
  Math.round(((cents ?? 0) as number)) / 100;

function mapProduct(row: ProductRow, storeId: string): Product {
  return {
    id: row.id,
    sku: row.barcode,
    name: row.name,
    barcode: row.barcode,
    onHand: row.on_hand ?? 0,
    par: row.par_qty ?? 0,
    reorderPoint: 0, // not a backend column yet; see header note
    cost: centsToDollars(row.cost_cents),
    price: centsToDollars(row.price_cents),
    location: '',
    supplier: '',
    storeId,
    needsSetup: (row.cost_cents ?? 0) === 0,
  };
}

function mapStore(row: StoreRow): Store {
  return {
    id: row.id,
    name: row.name,
    address: row.address ?? undefined,
    city: row.city ?? undefined,
    // The backend returns the store's most common per-product margin;
    // fall back to 30 only when the store carries nothing yet.
    marginPct: row.margin_pct != null ? Number(row.margin_pct) : 30,
    status: row.is_home ? 'pilot' : 'planned',
  };
}

function mapMovementType(type: string): MovementType {
  if (type === 'sale') return 'sale';
  if (type === 'receive') return 'receive';
  if (type === 'return') return 'return';
  if (type === 'count-correction') return 'count';
  return 'adjustment';
}

function mapMovement(
  row: MovementRow,
  productsById: Map<string, ProductRow>,
): Movement {
  const p = productsById.get(row.product_id);
  return {
    id: row.id,
    type: mapMovementType(row.type),
    barcode: p?.barcode ?? '',
    productName: p?.name ?? '',
    qty: Math.abs(row.qty_delta),
    delta: row.qty_delta,
    cost: centsToDollars(row.cost_cents),
    price: p ? centsToDollars(p.price_cents) : 0,
    reason: row.note ?? undefined,
    storeId: row.store_id,
    createdAt: row.created_at,
  };
}

async function defaultStoreId(provided?: string): Promise<string> {
  if (provided) return provided;
  const stores = await getStores();
  if (stores.length === 0) throw new Error('No stores configured — run the seed first.');
  return stores[0].id;
}

async function resolveProduct(
  barcode: string,
  storeId?: string,
): Promise<{ product: Product; storeId: string }> {
  const sid = await defaultStoreId(storeId);
  const products = await getProducts(sid);
  const product = products.find((p) => p.barcode === barcode);
  if (!product) throw new Error(`No product with barcode ${barcode} in the catalog.`);
  return { product, storeId: sid };
}

/* --------------------------------------------------------------- products */

/**
 * Products stocked at one store, with that store's on-hand and par.
 * With no store given, the first store (home store) is used: the
 * catalog-only endpoint has no on-hand/par columns, so calling it here
 * used to render every product at 0 on hand with par 0 on the Overview.
 */
export async function getProducts(storeId?: string): Promise<Product[]> {
  const sid = await defaultStoreId(storeId);
  const rows = await request<ProductRow[]>(`/api/products?storeId=${encodeURIComponent(sid)}`);
  return rows.map((r) => mapProduct(r, sid));
}

/** The whole catalog, no per-store stock figures (for matching/classification). */
export async function getCatalog(): Promise<Product[]> {
  const rows = await request<ProductRow[]>('/api/products');
  return rows.map((r) => mapProduct(r, ''));
}

/** Add a new product and stock it at the home store (or the given store). */
export async function createProduct(input: {
  barcode: string;
  name: string;
  category?: string;
  cost: number;
  price?: number;
  marginPct?: number;
  par?: number;
  storeId?: string;
}): Promise<Product> {
  const row = await request<ProductRow & { store_id?: string }>('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      barcode: input.barcode,
      name: input.name,
      category: input.category,
      costCents: Math.round(input.cost * 100),
      priceCents: input.price !== undefined ? Math.round(input.price * 100) : undefined,
      marginPct: input.marginPct,
      parQty: input.par ?? 0,
      storeId: input.storeId,
    }),
  });
  return mapProduct(row, input.storeId ?? '');
}

export async function getProductByBarcode(
  barcode: string,
  storeId?: string,
): Promise<Product> {
  const { product } = await resolveProduct(barcode, storeId);
  return product;
}

export async function getOverviewTotals(storeId?: string): Promise<OverviewTotals> {
  const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
  const s = await request<{
    total_units: number;
    inventory_value_cost_cents: number;
    inventory_value_retail_cents: number;
    low_stock_products: number;
    out_of_stock_products: number;
  }>(`/api/dashboard/summary${q}`);
  return {
    totalUnits: s.total_units,
    totalCostValue: centsToDollars(s.inventory_value_cost_cents),
    totalRetailValue: centsToDollars(s.inventory_value_retail_cents),
    lowStockCount: s.low_stock_products,
    outOfStockCount: s.out_of_stock_products,
  };
}

/** Restock every product to its par level. Returns the refreshed product list. */
export async function restockAllToPar(storeId?: string): Promise<Product[]> {
  const sid = await defaultStoreId(storeId);
  const res = await request<{ products: ProductRow[] }>('/api/products/restock-all', {
    method: 'POST',
    body: JSON.stringify({ storeId: sid }),
  });
  return res.products.map((r) => mapProduct(r, sid));
}

/* ------------------------------------------------------------------ sales */

export async function postSale(input: {
  barcode: string;
  qty: number;
  storeId?: string;
}): Promise<SaleResult> {
  const { product, storeId } = await resolveProduct(input.barcode, input.storeId);
  const res = await request<{ movement: MovementRow; onHand: number }>('/api/movements', {
    method: 'POST',
    body: JSON.stringify({
      storeId,
      productId: product.id,
      type: 'sale',
      qty: input.qty,
      costCents: Math.round(product.cost * 100),
      note: 'Sale — Scan / POS Terminal',
    }),
  });
  const productsById = new Map([[product.id, { ...product, cost_cents: Math.round(product.cost * 100), price_cents: Math.round(product.price * 100) } as ProductRow]]);
  return {
    movement: mapMovement(res.movement, productsById),
    product: { ...product, onHand: res.onHand },
    transactionTotal: input.qty * product.price,
  };
}

/* ---------------------------------------------------------------- receive */

export async function postReceive(input: {
  barcode: string;
  qty: number;
  cost?: number;
  supplier?: string;
  storeId?: string;
}): Promise<Movement> {
  const { product, storeId } = await resolveProduct(input.barcode, input.storeId);
  const res = await request<{ movement: MovementRow; onHand: number }>('/api/movements', {
    method: 'POST',
    body: JSON.stringify({
      storeId,
      productId: product.id,
      type: 'receive',
      qty: input.qty,
      costCents:
        input.cost !== undefined ? Math.round(input.cost * 100) : Math.round(product.cost * 100),
      note: input.supplier ? `Receive — ${input.supplier}` : 'Receive',
    }),
  });
  const productsById = new Map([[product.id, { ...product, cost_cents: Math.round(product.cost * 100), price_cents: Math.round(product.price * 100) } as ProductRow]]);
  return mapMovement(res.movement, productsById);
}

/* ------------------------------------------------------- commander pull */

export async function pullPriceBook(): Promise<PriceBookItem[]> {
  const { items } = await request<{ items: CommanderPriceBookRow[] }>(
    '/api/commander/price-book',
  );
  // Classify against the live catalog: the backend pull itself is unclassified.
  // Use the full catalog, not one store's stocked list, or unstocked
  // catalog products would be misclassified as "new".
  const catalog = await getCatalog();
  const known = new Set(catalog.map((p) => p.barcode));
  return items.map((it) => ({
    barcode: it.upc,
    name: it.name,
    price: centsToDollars(it.priceCents),
    cost: centsToDollars(it.costCents),
    status: !it.active ? 'inactive' : known.has(it.upc) ? 'duplicate' : 'new',
    department: it.category,
  }));
}

export async function importPriceBook(
  _items: PriceBookItem[],
  storeId?: string,
): Promise<ImportReport> {
  // The backend re-pulls the Commander price book itself and imports
  // add-new-only, so the caller's preview list is not re-sent.
  const sid = storeId ? await defaultStoreId(storeId) : undefined;
  const res = await request<{
    added: CommanderPriceBookRow[];
    addedCount: number;
    updated: number;
    skipped: { upc: string; name: string; classification: string }[];
    skippedCount: number;
  }>('/api/commander/price-book/import', {
    method: 'POST',
    body: JSON.stringify(sid ? { storeId: sid } : {}),
  });
  return {
    added: res.addedCount,
    updated: res.updated,
    skipped: res.skippedCount,
    needsSetup: res.added.map((it) => ({
      barcode: it.upc,
      name: it.name,
      price: centsToDollars(it.priceCents),
      cost: centsToDollars(it.costCents),
      status: 'new' as PriceBookStatus,
      department: it.category,
    })),
  };
}

/* ------------------------------------------------------------ invoice scan */

interface InvoiceDraftRow {
  id: string;
  supplier: string;
  invoiceNumber?: string;
  invoice_number?: string;
  status?: string;
  created_at?: string;
  lines: {
    id: string;
    name: string;
    barcode?: string | null;
    qty: number;
    unitCostCents?: number;
    unit_cost_cents?: number;
    status?: string;
    productId?: string | null;
    product_id?: string | null;
    confirmed?: boolean;
  }[];
}

function mapInvoiceDraft(row: InvoiceDraftRow): InvoiceDraft {
  return {
    id: row.id,
    supplier: row.supplier,
    invoiceNumber: row.invoiceNumber ?? row.invoice_number,
    lines: row.lines.map((l) => ({
      id: l.id,
      barcode: l.barcode ?? '',
      description: l.name,
      qty: l.qty,
      cost: centsToDollars(l.unitCostCents ?? l.unit_cost_cents),
      supplier: row.supplier,
      matchedProductId: l.productId ?? l.product_id ?? undefined,
      matchedProductName: l.status === 'matched' ? l.name : undefined,
      confirmed: l.confirmed ?? false,
    })),
    createdAt: row.created_at ?? '',
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read the invoice file.'));
    reader.readAsDataURL(file);
  });
}

export async function scanInvoice(
  file: File,
  storeId?: string,
  ocrText?: string,
): Promise<InvoiceDraft> {
  const sid = await defaultStoreId(storeId);
  const imageBase64 = await fileToBase64(file);
  const row = await request<InvoiceDraftRow>('/api/invoices/scan', {
    method: 'POST',
    body: JSON.stringify({ storeId: sid, imageBase64, ocrText }),
  });
  return mapInvoiceDraft(row);
}

/** A ready-made sample invoice, for demoing the review flow without a photo. */
export async function getSampleInvoice(storeId?: string): Promise<InvoiceDraft> {
  const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
  const row = await request<InvoiceDraftRow>(`/api/invoices/sample${q}`);
  return mapInvoiceDraft(row);
}

/** Correct a draft invoice line's qty/cost before confirming it. */
export async function updateInvoiceLine(
  draftId: string,
  line: InvoiceLine,
): Promise<void> {
  await request(`/api/invoices/${encodeURIComponent(draftId)}/lines/${encodeURIComponent(line.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      qty: Math.max(1, Math.round(line.qty)),
      unitCostCents: Math.max(0, Math.round(line.cost * 100)),
    }),
  });
}

/** Post only the lines the user confirmed. Unconfirmed lines are dropped. */
export async function postInvoiceDraft(
  draftId: string,
  lines: InvoiceLine[],
): Promise<Movement[]> {
  const confirmed = lines.filter((l) => l.confirmed);
  if (confirmed.length === 0) throw new Error('Confirm at least one line before posting.');
  // Push any qty/cost edits the user made in the draft table first:
  // the backend posts the stored line values, so edits sent only with the
  // confirm call used to be silently ignored. Re-saving an unchanged
  // line is harmless.
  for (const line of confirmed) {
    await updateInvoiceLine(draftId, line);
  }
  const res = await request<{ movements: MovementRow[] }>(
    `/api/invoices/${encodeURIComponent(draftId)}/confirm`,
    {
      method: 'POST',
      body: JSON.stringify({ lineIds: confirmed.map((l) => l.id) }),
    },
  );
  const products = await getCatalog();
  const byId = new Map(
    products.map((p) => [
      p.id,
      { ...p, cost_cents: Math.round(p.cost * 100), price_cents: Math.round(p.price * 100) } as ProductRow,
    ]),
  );
  return res.movements.map((m) => mapMovement(m, byId));
}

/* ----------------------------------------------------------------- stores */

export async function getStores(): Promise<Store[]> {
  const rows = await request<StoreRow[]>('/api/stores');
  return rows.map(mapStore);
}

export async function updateStore(
  storeId: string,
  patch: Partial<Pick<Store, 'marginPct' | 'status' | 'commanderModel'>> & {
    name?: string;
    city?: string;
    address?: string;
  },
): Promise<Store> {
  // marginPct is per-product, not per-store: it is applied via rollout.
  if (patch.marginPct !== undefined) {
    await request(`/api/stores/${encodeURIComponent(storeId)}/rollout`, {
      method: 'POST',
      body: JSON.stringify({ defaultMarginPct: patch.marginPct }),
    });
  }
  const namePatch: Record<string, string> = {};
  if (patch.name) namePatch.name = patch.name;
  if (patch.city) namePatch.city = patch.city;
  if (patch.address) namePatch.address = patch.address;
  if (Object.keys(namePatch).length > 0) {
    await request(`/api/stores/${encodeURIComponent(storeId)}`, {
      method: 'PATCH',
      body: JSON.stringify(namePatch),
    });
  }
  const stores = await getStores();
  const store = stores.find((s) => s.id === storeId);
  if (!store) throw new Error('Store not found after update.');
  return store;
}

/* ----------------------------------------------------------------- ledger */

export async function getMovements(storeId?: string): Promise<Movement[]> {
  const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
  const rows = await request<MovementRow[]>(`/api/movements${q}`);
  // Map against the full catalog, not one store's stocked list, or
  // movements for products not stocked at the default store would render
  // with a blank name/barcode.
  const products = await getCatalog();
  const byId = new Map(
    products.map((p) => [
      p.id,
      { ...p, cost_cents: Math.round(p.cost * 100), price_cents: Math.round(p.price * 100) } as ProductRow,
    ]),
  );
  return rows.map((r) => mapMovement(r, byId));
}

/* ------------------------------------------------------------ cycle count */

export async function postCycleCount(input: {
  barcode: string;
  countedQty: number;
  storeId?: string;
}): Promise<Movement> {
  const { product, storeId } = await resolveProduct(input.barcode, input.storeId);
  const res = await request<{
    cycleCount: { id: string };
    variance: number;
    movement: MovementRow | null;
    onHand: number;
  }>('/api/movements/cycle-counts', {
    method: 'POST',
    body: JSON.stringify({ storeId, productId: product.id, countedQty: input.countedQty }),
  });
  const byId = new Map([[product.id, { ...product, cost_cents: Math.round(product.cost * 100), price_cents: Math.round(product.price * 100) } as ProductRow]]);
  if (res.movement) return mapMovement(res.movement, byId);
  // No variance: no ledger movement was posted. Return a zero-qty count record.
  return {
    id: res.cycleCount.id,
    type: 'count',
    barcode: product.barcode,
    productName: product.name,
    qty: 0,
    delta: 0,
    cost: 0,
    price: product.price,
    reason: `Cycle count: counted ${input.countedQty}, matches book stock`,
    storeId,
    createdAt: new Date().toISOString(),
  };
}
