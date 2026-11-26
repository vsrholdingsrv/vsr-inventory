import { useState } from 'react';
import { getProductByBarcode, postReceive, type Product } from '../api';

export default function Receive() {
  const [barcode, setBarcode] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const [qty, setQty] = useState(1);
  const [cost, setCost] = useState('');
  const [supplier, setSupplier] = useState('');
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
      setCost(String(p.cost));
      setSupplier(p.supplier);
    } catch (e) {
      setProduct(null);
      setError(e instanceof Error ? e.message : `No product found for ${code}.`);
    } finally {
      setBusy(false);
    }
  }

  async function handleReceive() {
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      const m = await postReceive({
        barcode: product.barcode,
        qty,
        cost: cost === '' ? undefined : Number(cost),
        supplier: supplier || undefined,
      });
      setMessage(`Received ${m.qty} × ${product.name}. Check the Ledger for the new movement.`);
      const p = await getProductByBarcode(product.barcode);
      setProduct(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Receive failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Receive stock</h2>
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
            On hand: {product.onHand} · Par: {product.par} · Location: {product.location}
          </p>
          <div className="field">
            <label htmlFor="recv-qty">Quantity received</label>
            <input
              id="recv-qty"
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          <div className="field">
            <label htmlFor="recv-cost">Unit cost</label>
            <input
              id="recv-cost"
              type="number"
              min={0}
              step={0.01}
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="recv-supplier">Supplier</label>
            <input
              id="recv-supplier"
              type="text"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
          </div>
          <button className="primary" onClick={() => void handleReceive()} disabled={busy}>
            {busy ? 'Posting…' : 'Post receive'}
          </button>
        </div>
      )}
    </div>
  );
}
