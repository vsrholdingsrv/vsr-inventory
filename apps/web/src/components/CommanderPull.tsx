import { useState } from 'react';
import {
  importPriceBook,
  pullPriceBook,
  type ImportReport,
  type PriceBookItem,
} from '../api';

type Step = 'idle' | 'pulled' | 'imported';

export default function CommanderPull() {
  const [items, setItems] = useState<PriceBookItem[]>([]);
  const [step, setStep] = useState<Step>('idle');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const counts = {
    new: items.filter((i) => i.status === 'new').length,
    duplicate: items.filter((i) => i.status === 'duplicate').length,
    inactive: items.filter((i) => i.status === 'inactive').length,
  };

  async function handlePull() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const pulled = await pullPriceBook();
      setItems(pulled);
      setStep('pulled');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Price book pull failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    setBusy(true);
    setError(null);
    try {
      const rep = await importPriceBook(items);
      setReport(rep);
      setStep('imported');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="notice">
        <strong>Simulated Commander feed.</strong> This pull reads the prototype
        Commander price book — it is not yet a live Verifone Commander connection.
        Mapping and preview happen here before anything is imported.
      </div>

      <div className="card">
        <h2>Commander Pull / Price Book Import</h2>
        <p className="muted">
          Pull → Map → Preview (New / Duplicate / Inactive) → Import. New items are
          imported flagged <em>Needs setup</em> — cost, supplier, reorder, par and
          location are blank until filled from invoices.
        </p>
        <button className="primary" onClick={() => void handlePull()} disabled={busy}>
          {busy && step === 'idle' ? 'Pulling…' : 'Pull price book'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>

      {step !== 'idle' && (
        <div className="card">
          <h2>Preview</h2>
          <p>
            <span className="badge new">{counts.new} new</span>{' '}
            <span className="badge duplicate">{counts.duplicate} duplicate</span>{' '}
            <span className="badge inactive">{counts.inactive} inactive</span>
          </p>
          <table>
            <thead>
              <tr>
                <th>Barcode</th>
                <th>Name</th>
                <th>Price</th>
                <th>Cost</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.barcode}>
                  <td>{i.barcode}</td>
                  <td>{i.name}</td>
                  <td>${i.price.toFixed(2)}</td>
                  <td>${i.cost.toFixed(2)}</td>
                  <td>
                    <span className={`badge ${i.status}`}>{i.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {step === 'pulled' && (
            <button className="primary" onClick={() => void handleImport()} disabled={busy}>
              {busy ? 'Importing…' : `Import ${items.length} item(s)`}
            </button>
          )}
        </div>
      )}

      {step === 'imported' && report && (
        <div className="card">
          <h2>Import report</h2>
          <p>
            Added: <strong>{report.added}</strong> · Updated: <strong>{report.updated}</strong> ·{' '}
            Skipped: <strong>{report.skipped}</strong>
          </p>
          {report.needsSetup.length > 0 && (
            <>
              <h3>Needs setup</h3>
              <p className="muted">
                These items were imported with cost, supplier, reorder, par and location
                blank — fill them from invoices before they can be sold.
              </p>
              <ul>
                {report.needsSetup.map((i) => (
                  <li key={i.barcode}>
                    {i.name} ({i.barcode})
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
