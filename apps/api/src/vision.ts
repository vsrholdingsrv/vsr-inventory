/**
 * Google Cloud Vision OCR — the exact-details reader for invoice photos.
 *
 * Why this exists: the built-in reader (Tesseract.js, running on the
 * phone) cannot read the user's Red Bull invoice exactly, no matter how
 * the photo is cleaned or which settings are used — it was tested 8 ways
 * on that photo and never once got all 6 lines right (48→4, $53.11→
 * $63.11, whole rows lost). Tesseract is a free offline reader; Vision
 * is Google's document reader and reads this kind of invoice near
 * perfectly. The app keeps Tesseract as the fallback when no Vision key
 * is configured.
 *
 * Setup (owner): Google Cloud project → enable Cloud Vision API → create
 * an API key → set GOOGLE_VISION_API_KEY on the Render Web Service.
 * First 1,000 pages/month are free; after that ~$1.50 per 1,000 pages.
 * At one store's invoice volume that is effectively free.
 *
 * The response gives every word with its bounding box, so rows are
 * rebuilt from word positions (same idea as the Tesseract TSV path) and
 * then parsed by parseOcrRows in invoice.ts.
 */

export interface VisionWord {
  text: string;
  /** Left edge in pixels (image coordinates). */
  left: number;
  /** Vertical centre in pixels. */
  yc: number;
}

export interface VisionRead {
  /** Full document text, as Vision read it. */
  text: string;
  /** Table rows rebuilt from word positions, top to bottom. */
  rows: string[];
  /** Image height in pixels, from the Vision page metadata. */
  imageHeight: number;
}

interface VisionApiResponse {
  responses?: {
    fullTextAnnotation?: {
      text?: string;
      pages?: {
        width?: number;
        height?: number;
        blocks?: {
          paragraphs?: {
            words?: {
              boundingBox?: {
                vertices?: { x?: number; y?: number }[];
              };
              symbols?: { text?: string }[];
            }[];
          }[];
        }[];
      }[];
    };
    error?: { message?: string };
  }[];
}

/** Group words into rows by vertical band, left to right within a row. */
export function groupVisionWords(
  words: VisionWord[],
  imageHeight: number,
): string[] {
  const tol = Math.max(14, Math.round(imageHeight * 0.0065));
  const rows: { yc: number; words: { left: number; text: string }[] }[] = [];
  for (const w of words) {
    let g = rows.find((r) => Math.abs(r.yc - w.yc) <= tol);
    if (!g) {
      g = { yc: w.yc, words: [] };
      rows.push(g);
    }
    g.words.push({ left: w.left, text: w.text });
    g.yc = g.words.reduce((s) => s + w.yc, 0) / g.words.length;
  }
  rows.sort((a, b) => a.yc - b.yc);
  return rows
    .map((r) =>
      r.words
        .sort((a, b) => a.left - b.left)
        .map((w) => w.text)
        .join(' '),
    )
    .filter(Boolean);
}

/**
 * Read an invoice photo with Google Cloud Vision DOCUMENT_TEXT_DETECTION.
 * `fetchFn` is injectable so tests can run without a key or network.
 */
export async function readInvoiceWithVision(
  imageBase64: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<VisionRead> {
  const clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const res = await fetchFn(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: clean },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          },
        ],
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Google Vision request failed (${res.status}).`);
  }
  const data = (await res.json()) as VisionApiResponse;
  const first = data.responses?.[0];
  if (first?.error) {
    throw new Error(`Google Vision error: ${first.error.message ?? 'unknown'}.`);
  }
  const annotation = first?.fullTextAnnotation;
  const text = annotation?.text ?? '';
  if (text.trim().length < 20) {
    throw new Error('Google Vision could not read any text from this photo.');
  }
  const page = annotation?.pages?.[0];
  const imageHeight = page?.height ?? 0;
  const words: VisionWord[] = [];
  for (const block of page?.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const word of para.words ?? []) {
        const vertices = word.boundingBox?.vertices ?? [];
        if (vertices.length === 0) continue;
        const xs = vertices.map((v) => v.x ?? 0);
        const ys = vertices.map((v) => v.y ?? 0);
        const textOut = (word.symbols ?? []).map((s) => s.text ?? '').join('');
        if (!textOut.trim()) continue;
        words.push({
          text: textOut,
          left: Math.min(...xs),
          yc: (Math.min(...ys) + Math.max(...ys)) / 2,
        });
      }
    }
  }
  return {
    text,
    rows: imageHeight > 0 ? groupVisionWords(words, imageHeight) : [],
    imageHeight,
  };
}
