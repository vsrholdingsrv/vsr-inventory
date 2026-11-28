/**
 * OpenAI vision invoice reading — the exact-details reader for photos.
 *
 * Why this exists: the built-in reader (Tesseract.js, running on the
 * phone) cannot read the user's Red Bull invoice exactly, no matter how
 * the photo is cleaned or which settings are used — it was tested 8 ways
 * on that photo and never once got all 6 lines right (48→4, $53.11→
 * $63.11, whole rows lost). A vision model reads the same photo like a
 * person does. GPT-4o is used, not the cheaper mini, because the user
 * asked for exact details and this photo is folded and shot at an angle.
 * Cost is roughly $0.01–0.02 per invoice photo.
 *
 * Setup (owner): platform.openai.com → API keys → create a key, add a
 * little credit ($5 is plenty to start) → set OPENAI_API_KEY on the
 * Render Web Service. The key is never stored in the repo or in chat.
 *
 * The model returns structured JSON, never free text, and is told to
 * report unreadable fields as null instead of guessing — a line with a
 * missing quantity or total is dropped by the parser rather than
 * invented. When no key is configured, or the call fails, the scan
 * route falls back to the phone reader (Tesseract rows) instead of
 * failing the scan.
 */

import type { InvoiceLineInput } from './invoice';

export interface OpenAiInvoiceLine {
  /** Item code printed on the line, e.g. "RB1718" (may be null). */
  code?: string | null;
  /** Description as printed, e.g. "RED BULL 8.4OZ LS". */
  description: string;
  /** Total units on the line (the UNITS column), e.g. 48. */
  units: number;
  /** Cost per unit in dollars, e.g. 1.68 (may be null if not readable). */
  unitCost?: number | null;
  /** Line total in dollars as printed, e.g. 80.78. */
  total?: number | null;
  /** 12-digit barcode printed under the description (may be null). */
  barcode?: string | null;
}

export interface OpenAiInvoiceRead {
  supplier: string;
  invoiceNumber: string;
  lines: InvoiceLineInput[];
  expectedTotalCents: number | null;
  expectedUnits: number | null;
}

interface OpenAiChatResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string;
  }[];
  error?: { message?: string };
}

const SYSTEM_PROMPT = `You read supplier invoices from photos and return the exact details as JSON. Copy what is printed — never guess, never round, never invent a value. If a field is unreadable, return null for it.

Return ONLY a JSON object with this shape:
{
  "supplier": "company name at the top of the invoice, or null",
  "invoiceNumber": "the invoice number, or null",
  "lines": [
    {
      "code": "item code like RB1718, or null",
      "description": "item description exactly as printed",
      "units": total units on the line (the UNITS column, not cases),
      "unitCost": cost per single unit in dollars (line TOTAL divided by UNITS), or null,
      "total": line total in dollars as printed, or null,
      "barcode": "12-digit barcode printed under the description, or null"
    }
  ],
  "totals": {
    "unitsDelivered": total units delivered as printed, or null,
    "invoiceTotal": invoice total in dollars as printed, or null
  }
}

Rules:
- "units" is the total units column. If the invoice shows cases and units, use the units number.
- "unitCost" is line total divided by units. Work it out from the printed total, do not estimate from the price column.
- Include every item line, even if one field on it is unreadable.
- Skip the totals block, headers, and any handwriting — those are not lines.
- If the photo is not an invoice at all, return {"supplier": null, "invoiceNumber": null, "lines": [], "totals": {"unitsDelivered": null, "invoiceTotal": null}}.`;

export function parseOpenAiInvoiceJson(raw: string): OpenAiInvoiceRead {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('OpenAI returned a response that was not valid JSON.');
  }
  const lines: InvoiceLineInput[] = [];
  for (const l of Array.isArray(data.lines) ? data.lines : []) {
    const qty = Number(l.units);
    if (!l.description || typeof l.description !== 'string') continue;
    if (!Number.isFinite(qty) || qty < 1 || qty > 999) continue;
    let unitCostCents: number | null =
      typeof l.unitCost === 'number' && Number.isFinite(l.unitCost)
        ? Math.round(l.unitCost * 100)
        : null;
    if (
      unitCostCents === null &&
      typeof l.total === 'number' &&
      Number.isFinite(l.total)
    ) {
      unitCostCents = Math.round((l.total * 100) / qty);
    }
    if (unitCostCents === null || unitCostCents < 5 || unitCostCents > 20000) continue;
    const barcode =
      typeof l.barcode === 'string' && /^\d{12}$/.test(l.barcode.trim())
        ? l.barcode.trim()
        : '';
    const name = l.description.trim().replace(/\s+/g, ' ');
    lines.push({ name, barcode, qty, unitCostCents });
  }
  return {
    supplier:
      typeof data.supplier === 'string' && data.supplier.trim()
        ? data.supplier.trim()
        : 'Unknown supplier',
    invoiceNumber:
      typeof data.invoiceNumber === 'string' ? data.invoiceNumber.trim() : '',
    lines,
    expectedTotalCents:
      typeof data.totals?.invoiceTotal === 'number'
        ? Math.round(data.totals.invoiceTotal * 100)
        : null,
    expectedUnits:
      typeof data.totals?.unitsDelivered === 'number'
        ? data.totals.unitsDelivered
        : null,
  };
}

/**
 * Read an invoice photo with GPT-4o vision. `fetchFn` is injectable so
 * tests can run without a key or network.
 */
export async function readInvoiceWithOpenAi(
  imageBase64: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenAiInvoiceRead> {
  const clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Read this supplier invoice and return the exact details as JSON.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${clean}` },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('OpenAI rejected the API key (401). Check the key on Render.');
    }
    if (res.status === 429) {
      throw new Error('OpenAI rate limit or no credit left (429). Add credit on platform.openai.com.');
    }
    throw new Error(`OpenAI request failed (${res.status}). ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as OpenAiChatResponse;
  if (data.error) {
    throw new Error(`OpenAI error: ${data.error.message ?? 'unknown'}.`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI returned an empty response.');
  }
  return parseOpenAiInvoiceJson(content);
}
