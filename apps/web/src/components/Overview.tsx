import { useCallback, useEffect, useState } from 'react';
import {
  getOverviewTotals,
  getProducts,
  restockAllToPar,
  type OverviewTotals,
  type Product,
} from '../api';

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function Overview() {
  const [products, setProducts] = useState<Product[]>([]);
  const [totals, setTotals] = useState<OverviewTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restocking, setRestocking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ps, t] = await Promise.all([getProducts(), getOverviewTotals()]);
      setProducts(ps);
      setTotals(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load overview.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Low/out is judged against par (the reorder target), not reorderPoint:
  // the backend has no per-product reorder_point column yet, so
  // reorderPoint is always 0 and `onHand <= reorderPoint` was never true
  // for in-stock items — low-stock alerts never fired.
  const low = products.filter((p) => p.onHand > 0 && p.par > 0 && p.onHand < p.par);
  const out = products.filter((p) => p.onHand <= 0 && p.par > 0);

  async function handleRestockAll() {
    setRestocking(true);
    setError(null);
    try {
      const updated = await restockAllToPar();
      setProducts(updated);
      const t = await getOverviewTotals();
      setTotals(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restock failed.');
    } finally {
      setRestocking(false);
    }
  }

  if (loading) return <p>Loading stock board…</p>;

  return (
    <div>
      {error && <p className="error">{error}</p>}

      <div className="grid two">
        <div className="card">
          <span className="muted">Total units on hand</span>
          <p className="stat">{totals?.totalUnits ?? products.reduce((s, p) => s + p.onHand, 0)}</p>
        </div>
        <div className="card">
          <span className="muted">Inventory value (cost)</span>
          <p className="stat">{money(totals?.totalCostValue ?? 0)}</p>
        </div>
        <div className="card">
          <span className="muted">Inventory value (retail)</span>
          <p className="stat">{money(totals?.totalRetailValue ?? 0)}</p>
        </div>
        <div className="card">
          <span className="muted">Low / out of stock</span>
          <p className="stat">
            <span className="alert-low">{totals?.lowStockCount ?? low.length} low</span>
            {' / '}
            <span className="alert-out">{totals?.outOfStockCount ?? out.length} out</span>
          </p>
        </div>
      </div>

      <div className="card">
        <button className="primary" onClick={() => void handleRestockAll()} disabled={restocking}>
          {restocking ? 'Restocking…' : 'Restock all to par'}
        </button>
        <p className="muted">Brings every product up to its par level (demo restock).</p>
      </div>

      {(low.length > 0 || out.length > 0) && (
        <div className="card">
          <h2>Alerts</h2>
          {out.map((p) => (
            <p key={p.id} className="alert-out">
              OUT — {p.name} ({p.barcode}): 0 on hand, par {p.par}
            </p>
          ))}
          {low.map((p) => (
            <p key={p.id} className="alert-low">
              LOW — {p.name} ({p.barcode}): {p.onHand} on hand, par {p.par}
            </p>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Stock board</h2>
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Barcode</th>
              <th>On hand</th>
              <th>Par</th>
              <th>Price</th>
              <th>Cost</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.barcode}</td>
                <td className={p.onHand <= 0 ? 'alert-out' : p.onHand <= p.reorderPoint ? 'alert-low' : ''}>
                  {p.onHand}
                </td>
                <td>{p.par}</td>
                <td>{money(p.price)}</td>
                <td>{money(p.cost)}</td>
                <td>{p.location}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {products.length === 0 && <p className="muted">No products yet — pull the Commander price book first.</p>}
      </div>
    </div>
  );
}
