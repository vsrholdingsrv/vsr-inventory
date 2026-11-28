import { useState } from 'react';
import { createWorker, PSM } from 'tesseract.js';
import {
  createManualInvoice,
  getSampleInvoice,
  postInvoiceDraft,
  scanInvoice,
  scanInvoiceText,
  type InvoiceDraft,
  type InvoiceLine,
} from '../api';

/**
 * Clean the photo before OCR: upscale 2x, grayscale, stretch the contrast
 * so faint dot-matrix print turns dark on white. On the user's Red Bull
 * photo this lifted the reader's hit rate on codes and totals from ~40%
 * to ~60% — still not perfect, which is why the paste-text path exists.
 */
async function preprocessImage(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not load the invoice photo.'));
      el.src = url;
    });
    const scale = Math.min(2, 2400 / img.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { blob: file, width: 0, height: 0 };
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    // Luminance histogram for contrast stretch (1st–99th percentile).
    const hist = new Array<number>(256).fill(0);
    for (let i = 0; i < px.length; i += 4) {
      const g = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
      hist[g]++;
    }
    const total = px.length / 4;
    let lo = 0;
    let acc = 0;
    while (lo < 255 && acc < total * 0.01) acc += hist[lo++];
    let hi = 255;
    acc = 0;
    while (hi > 0 && acc < total * 0.01) acc += hist[hi--];
    if (hi <= lo) return { blob: file, width: canvas.width, height: canvas.height };
    const range = hi - lo;
    for (let i = 0; i < px.length; i += 4) {
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const v = Math.max(0, Math.min(255, ((g - lo) / range) * 255));
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    return { blob: blob ?? file, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Rebuild invoice table rows from Tesseract's word positions (TSV level 5).
 * Plain OCR text scatters one row's fields across lines — the code on one
 * line, the money on another — which is why photo scans came back empty or
 * wrong. Words sharing a vertical band are one row, whatever order the
 * reader emitted them in.
 */
function groupWordsIntoRows(tsv: string, imageHeight: number): string[] {
  const tol = Math.max(14, Math.round(imageHeight * 0.0065));
  const rows: { yc: number; words: { left: number; text: string }[] }[] = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c[0] !== '5' || !c[11] || !c[11].trim()) continue;
    const left = Number(c[6]);
    const top = Number(c[7]);
    const h = Number(c[9]);
    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(h)) continue;
    const yc = top + h / 2;
    let g = rows.find((r) => Math.abs(r.yc - yc) <= tol);
    if (!g) {
      g = { yc, words: [] };
      rows.push(g);
    }
    g.words.push({ left, text: c[11].trim() });
    g.yc = g.words.reduce((s) => s + yc, 0) / g.words.length;
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

export default function InvoiceScan() {
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');

  async function handlePaste() {
    if (pasteText.trim().length < 20) {
      setError('Paste the invoice text first — open the photo in Photos, select the text, copy it, and paste it here.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setDraft(await scanInvoiceText(pasteText));
      setMessage('Draft created from the pasted text — review each line before posting.');
      setShowPaste(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read any invoice lines from that text.');
    } finally {
      setBusy(false);
    }
  }
  const [manualSupplier, setManualSupplier] = useState('');
  const [manualInvoiceNo, setManualInvoiceNo] = useState('');
  const [manualLines, setManualLines] = useState<
    { name: string; qty: string; cost: string }[]
  >([{ name: '', qty: '', cost: '' }]);

  async function handleManual() {
    const lines = manualLines
      .filter((l) => l.name.trim() && Number(l.qty) > 0)
      .map((l) => ({
        name: l.name.trim(),
        qty: Number(l.qty),
        unitCostCents: Math.round(Number(l.cost || 0) * 100),
      }));
    if (!manualSupplier.trim()) {
      setError('Enter the supplier name for the manual invoice.');
      return;
    }
    if (lines.length === 0) {
      setError('Enter at least one line with a product name and a quantity.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setDraft(await createManualInvoice(manualSupplier.trim(), manualInvoiceNo.trim(), lines));
      setMessage('Manual draft created — review each line before posting.');
      setShowManual(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the manual draft.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Read the photo with Tesseract.js ON THE PHONE, then send the *text* to
   * the server. The old flow sent only the image and the server answered
   * with the fixed Core-Mark sample for every photo — that is why real
   * invoices "scanned" as sample data.
   */
  async function handleFile(file: File) {
    if (!file.type.startsWith('image/')) {
      setError('That file is not a photo. Take a photo or pick an image of the invoice.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    setOcrText(null);
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    try {
      setOcrStatus('Cleaning up the photo…');
      const clean = await preprocessImage(file);
      setOcrStatus('Reading the invoice photo…');
      worker = await createWorker('eng', undefined, {
        logger: (m) => {
          if (m.status === 'recognizing text' && typeof m.progress === 'number') {
            setOcrStatus(`Reading the invoice photo… ${Math.round(m.progress * 100)}%`);
          }
        },
      });
      // PSM 6: one uniform block of text — reads dense invoice tables far
      // better than the default auto page segmentation (PSM 3), which
      // scrambles table rows and is why clean photos came back unreadable.
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      // Ask for TSV too: word positions let the server rebuild each table
      // row from words sharing a vertical band, instead of trusting the
      // reader's line order (which splits one row across several lines).
      const { data } = await worker.recognize(clean.blob, {}, { text: true, tsv: true });
      const text = data.text ?? '';
      setOcrText(text);
      if (text.trim().length < 20) {
        throw new Error(
          'Could not read any text from this photo. Try a closer, well-lit shot of the full invoice.',
        );
      }
      const rows =
        typeof data.tsv === 'string' && clean.height > 0
          ? groupWordsIntoRows(data.tsv, clean.height)
          : [];
      setOcrStatus('Matching lines to the catalog…');
      setDraft(await scanInvoice(file, undefined, text, rows.length ? rows : undefined));
      setMessage('Draft created from your photo — review each line before posting.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invoice scan failed.');
    } finally {
      if (worker) {
        try {
          await worker.terminate();
        } catch {
          // Worker already stopped; nothing to do.
        }
      }
      setOcrStatus(null);
      setBusy(false);
    }
  }

  async function handleSample() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setDraft(await getSampleInvoice());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the sample invoice.');
    } finally {
      setBusy(false);
    }
  }

  function updateLine(id: string, patch: Partial<InvoiceLine>) {
    setDraft((d) =>
      d ? { ...d, lines: d.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) } : d,
    );
  }

  async function handlePost() {
    if (!draft) return;
    const confirmed = draft.lines.filter((l) => l.confirmed);
    if (confirmed.length === 0) {
      setError('Confirm at least one line before posting. Unconfirmed lines are never posted.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const movements = await postInvoiceDraft(draft.id, draft.lines);
      setMessage(`Posted ${movements.length} confirmed line(s) to the ledger as receives.`);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Posting failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Invoice Scan</h2>
        <p className="muted">
          Photograph or upload a supplier invoice. The photo is read on your
          phone and the lines become a draft — nothing posts until you review
          and confirm each line. For the best read, lay the invoice flat, fill
          the frame with it, and use good light — a folded or angled photo
          misreads quantities and prices.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label className="primary" style={{ cursor: 'pointer', padding: '9px 14px', borderRadius: 6 }}>
            Take photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
          </label>
          <label className="secondary" style={{ cursor: 'pointer', padding: '9px 14px', borderRadius: 6 }}>
            Choose file / Photo Library
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
          </label>
          <button className="secondary" onClick={() => void handleSample()} disabled={busy}>
            Load sample invoice
          </button>
          <button className="secondary" onClick={() => setShowManual((v) => !v)} disabled={busy}>
            {showManual ? 'Hide manual entry' : 'Enter lines manually'}
          </button>
          <button className="secondary" onClick={() => setShowPaste((v) => !v)} disabled={busy}>
            {showPaste ? 'Hide paste text' : 'Paste invoice text'}
          </button>
        </div>
        {showPaste && (
          <div style={{ marginTop: 12, borderTop: '1px solid #ddd', paddingTop: 12 }}>
            <p className="muted">
              Your iPhone reads invoices far better than this app's built-in
              reader. Open the photo in Photos, press and hold the text to
              select it all, copy it, and paste it here.
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste the invoice text here…"
              rows={8}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
            <div style={{ marginTop: 8 }}>
              <button className="primary" onClick={() => void handlePaste()} disabled={busy}>
                Create draft from pasted text
              </button>
            </div>
          </div>
        )}
        {showManual && (
          <div style={{ marginTop: 12, borderTop: '1px solid #ddd', paddingTop: 12 }}>
            <p className="muted">
              Use this when the photo cannot be read. Type the lines from the
              invoice — they become a draft, same as a scan, and nothing posts
              until you confirm each line.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <input
                type="text"
                placeholder="Supplier, e.g. Red Bull Distribution"
                value={manualSupplier}
                onChange={(e) => setManualSupplier(e.target.value)}
                style={{ flex: '1 1 220px' }}
              />
              <input
                type="text"
                placeholder="Invoice # (optional)"
                value={manualInvoiceNo}
                onChange={(e) => setManualInvoiceNo(e.target.value)}
                style={{ flex: '1 1 140px' }}
              />
            </div>
            {manualLines.map((l, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <input
                  type="text"
                  placeholder="Product name"
                  value={l.name}
                  onChange={(e) =>
                    setManualLines((rows) =>
                      rows.map((r, i) => (i === idx ? { ...r, name: e.target.value } : r)),
                    )
                  }
                  style={{ flex: '2 1 160px' }}
                />
                <input
                  type="number"
                  min={0}
                  placeholder="Qty (units)"
                  value={l.qty}
                  onChange={(e) =>
                    setManualLines((rows) =>
                      rows.map((r, i) => (i === idx ? { ...r, qty: e.target.value } : r)),
                    )
                  }
                  style={{ width: 90 }}
                />
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="Cost / unit $"
                  value={l.cost}
                  onChange={(e) =>
                    setManualLines((rows) =>
                      rows.map((r, i) => (i === idx ? { ...r, cost: e.target.value } : r)),
                    )
                  }
                  style={{ width: 110 }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="secondary"
                onClick={() => setManualLines((rows) => [...rows, { name: '', qty: '', cost: '' }])}
              >
                + Add line
              </button>
              <button className="primary" onClick={() => void handleManual()} disabled={busy}>
                Create draft from these lines
              </button>
            </div>
          </div>
        )}
        {busy && ocrStatus && <p className="muted">{ocrStatus}</p>}
        {error && <p className="error">{error}</p>}
        {message && <p>{message}</p>}
        {ocrText && (
          <details style={{ marginTop: 12 }}>
            <summary>What was read from the photo</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{ocrText}</pre>
          </details>
        )}
      </div>

      {draft && (
        <div className="card">
          <h2>
            Draft — {draft.supplier}
            {draft.invoiceNumber ? ` · Invoice ${draft.invoiceNumber}` : ''}
          </h2>
          {draft.reconciliation && !draft.reconciliation.matches && (
            <p className="error">
              These lines do not add up to the invoice totals — check every
              line before posting. Lines total $
              {(draft.reconciliation.linesTotalCents / 100).toFixed(2)} for{' '}
              {draft.reconciliation.linesUnits} units
              {draft.reconciliation.expectedTotalCents !== null &&
                `, but the invoice says $${(draft.reconciliation.expectedTotalCents / 100).toFixed(2)}`}
              {draft.reconciliation.expectedUnits !== null &&
                ` and ${draft.reconciliation.expectedUnits} units delivered`}
              . The photo was probably misread.
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Confirm</th>
                <th>Barcode / Description</th>
                <th>Qty</th>
                <th>Cost</th>
                <th>Supplier</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l) => {
                const matched = Boolean(l.matchedProductId);
                return (
                  <tr key={l.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={l.confirmed}
                        disabled={!matched}
                        title={matched ? 'Confirm this line' : 'Unmatched lines cannot be confirmed or posted'}
                        onChange={(e) => updateLine(l.id, { confirmed: e.target.checked })}
                        aria-label={`Confirm line ${l.description}`}
                      />
                    </td>
                    <td>
                      <div>{l.description}</div>
                      <div className="muted">{l.barcode || '—'}</div>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        value={l.qty}
                        style={{ width: 70 }}
                        onChange={(e) => updateLine(l.id, { qty: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={l.cost}
                        style={{ width: 80 }}
                        onChange={(e) => updateLine(l.id, { cost: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={l.supplier}
                        style={{ width: 120 }}
                        onChange={(e) => updateLine(l.id, { supplier: e.target.value })}
                      />
                    </td>
                    <td>
                      {matched ? (
                        <span className="badge new">{l.matchedProductName ?? 'Matched'}</span>
                      ) : (
                        <span className="badge no-match">NO MATCH — ADD OR SKIP</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">
            Unmatched lines are flagged NO MATCH — ADD OR SKIP: they cannot be
            confirmed or posted (the checkbox is disabled). Add the product to
            the catalog first, then re-scan, or leave them unchecked and they
            will not post.
          </p>
          <button className="primary" onClick={() => void handlePost()} disabled={busy}>
            {busy ? 'Posting…' : 'Post confirmed lines only'}
          </button>
        </div>
      )}
    </div>
  );
}
