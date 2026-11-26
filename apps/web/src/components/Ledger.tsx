import { useCallback, useEffect, useState } from 'react';
import { getMovements, type Movement } from '../api';

export default function Ledger() {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMovements(await getMovements());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the ledger.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p>Loading ledger…</p>;

  return (
    <div className="card">
      <h2>Ledger</h2>
      <p className="muted">
        Every stock change — sale, receive, adjustment, count — is a ledger
        movement. Sales reduce on-hand; receives increase it.
      </p>
      {error && <p className="error">{error}</p>}
      <button className="secondary" onClick={() => void load()}>
        Refresh
      </button>
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Product</th>
            <th>Barcode</th>
            <th>Qty</th>
            <th>Delta</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id}>
              <td>{new Date(m.createdAt).toLocaleString()}</td>
              <td>
                <span className="badge">{m.type}</span>
              </td>
              <td>{m.productName}</td>
              <td>{m.barcode}</td>
              <td>{m.qty}</td>
              <td>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
              <td>{m.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {movements.length === 0 && <p className="muted">No movements yet.</p>}
    </div>
  );
}
