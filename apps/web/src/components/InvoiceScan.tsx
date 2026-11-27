import { useState } from 'react';
import {
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

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setDraft(await scanInvoice(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invoice scan failed.');
    } finally {
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
          Photograph or upload a supplier invoice. Lines are OCR’d into a draft —
          nothing posts until you review and confirm each line.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label className="primary" style={{ cursor: 'pointer', padding: '9px 14px', borderRadius: 6 }}>
            Photo / upload invoice
            <input
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
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
        </div>
        {error && <p className="error">{error}</p>}
        {message && <p>{message}</p>}
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
