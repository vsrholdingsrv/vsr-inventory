import { useState } from 'react';
import { createWorker, PSM } from 'tesseract.js';
import {
  createManualInvoice,
  getSampleInvoice,
  postInvoiceDraft,
  scanInvoice,
  type InvoiceDraft,
  type InvoiceLine,
} from '../api';

export default function InvoiceScan() {
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
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
      const { data } = await worker.recognize(file);
      const text = data.text ?? '';
      setOcrText(text);
      if (text.trim().length < 20) {
        throw new Error(
          'Could not read any text from this photo. Try a closer, well-lit shot of the full invoice.',
        );
      }
      setOcrStatus('Matching lines to the catalog…');
      setDraft(await scanInvoice(file, undefined, text));
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
        </div>
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
