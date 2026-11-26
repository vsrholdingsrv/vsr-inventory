import { useState } from 'react';
import { getProductByBarcode, postSale, type Product } from '../api';

interface Line {
  product: Product;
  qty: number;
}

export default function PosTerminal() {
  const [barcode, setBarcode] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const total = lines.reduce((s, l) => s + l.qty * l.product.price, 0);

  async function ring() {
    const code = barcode.trim();
    if (!code) return;
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const p = await getProductByBarcode(code);
      const existing = lines.find((l) => l.product.barcode === p.barcode);
      if ((existing?.qty ?? 0) + 1 > p.onHand) {
        setError(`Only ${p.onHand} on hand for ${p.name} — cannot ring more.`);
        return;
      }
      setLines((prev) => {
        if (existing) {
          return prev.map((l) =>
            l.product.barcode === p.barcode ? { ...l, qty: l.qty + 1 } : l,
          );
        }
        return [...prev, { product: p, qty: 1 }];
      });
      setBarcode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : `No product found for ${code}.`);
    } finally {
      setBusy(false);
    }
  }

  async function completeSale() {
    if (lines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let grandTotal = 0;
      for (const line of lines) {
        const res = await postSale({ barcode: line.product.barcode, qty: line.qty });
        grandTotal += res.transactionTotal;
      }
      setMessage(`Sale complete — ${lines.length} line(s), total $${grandTotal.toFixed(2)}.`);
      setLines([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sale failed. Some lines may already be posted — check the Ledger.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="notice">
        POS Terminal — sales post to the ledger as they are rung. In the prototype the
        Commander feed is simulated; this terminal posts sales through the VSR API.
      </div>

      <div className="card">
        <h2>Ring a sale</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void ring();
            }}
            placeholder="Scan or type a barcode, then Enter"
            inputMode="numeric"
            autoFocus
          />
          <button className="primary" onClick={() => void ring()} disabled={busy}>
            Add
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {message && <p>{message}</p>}
      </div>

      <div className="card">
        <h2>Current transaction</h2>
        {lines.length === 0 ? (
          <p className="muted">No items yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Line total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.product.barcode}>
                  <td>{l.product.name}</td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      max={l.product.onHand}
                      value={l.qty}
                      style={{ width: 80 }}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        const capped = Number.isFinite(n)
                          ? Math.max(1, Math.min(n, l.product.onHand))
                          : 1;
                        setLines((prev) =>
                          prev.map((x) =>
                            x.product.barcode === l.product.barcode ? { ...x, qty: capped } : x,
                          ),
                        );
                      }}
                    />
                  </td>
                  <td>${l.product.price.toFixed(2)}</td>
                  <td>${(l.qty * l.product.price).toFixed(2)}</td>
                  <td>
                    <button
                      className="secondary"
                      onClick={() =>
                        setLines((prev) => prev.filter((x) => x.product.barcode !== l.product.barcode))
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="stat">Total: ${total.toFixed(2)}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={() => void completeSale()} disabled={busy || lines.length === 0}>
            Complete sale
          </button>
          <button className="secondary" onClick={() => setLines([])} disabled={lines.length === 0}>
            Void
          </button>
        </div>
      </div>
    </div>
  );
}
