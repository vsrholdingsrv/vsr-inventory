import { useState } from 'react';
import { getProductByBarcode, postCycleCount, type Product } from '../api';

export default function CycleCount() {
  const [barcode, setBarcode] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const [counted, setCounted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup() {
    const code = barcode.trim();
    if (!code) return;
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const p = await getProductByBarcode(code);
      setProduct(p);
      setCounted(0);
    } catch (e) {
      setProduct(null);
      setError(e instanceof Error ? e.message : `No product found for ${code}.`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      const m = await postCycleCount({ barcode: product.barcode, countedQty: counted });
      const variance = counted - product.onHand;
      setMessage(
        `Count posted for ${product.name}: counted ${counted}, system had ${product.onHand} ` +
          `(variance ${variance > 0 ? `+${variance}` : variance}). Ledger delta ${m.delta}.`,
      );
      const p = await getProductByBarcode(product.barcode);
      setProduct(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cycle count failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Blind cycle count</h2>
        <p className="muted">
          Enter the barcode, then count the shelf without seeing the system
          on-hand figure — it is only revealed after you submit, so the count
          stays blind.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void lookup();
            }}
            placeholder="Scan or type a barcode"
            inputMode="numeric"
          />
          <button className="secondary" onClick={() => void lookup()} disabled={busy}>
            Look up
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {message && <p>{message}</p>}
      </div>

      {product && (
        <div className="card">
          <h2>{product.name}</h2>
          <p className="muted">
            {product.barcode} · {product.location}
          </p>
          <div className="field">
            <label htmlFor="counted-qty">Counted quantity (on shelf)</label>
            <input
              id="counted-qty"
              type="number"
              min={0}
              value={counted}
              onChange={(e) => setCounted(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
          <button className="primary" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? 'Posting…' : 'Submit count'}
          </button>
        </div>
      )}
    </div>
  );
}
