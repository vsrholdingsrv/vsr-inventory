import { useEffect, useState } from 'react';
import { getStores, updateStore, type Store } from '../api';

/** Four-store rollout. Margin % drives the auto price preview: price = cost × (1 + margin). */
const DEMO_COST = 1.0;

export default function Stores() {
  const [stores, setStores] = useState<Store[]>([]);
  const [margins, setMargins] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const ss = await getStores();
        setStores(ss);
        setMargins(Object.fromEntries(ss.map((s) => [s.id, s.marginPct])));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load stores.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await Promise.all(
        stores.map((s) => updateStore(s.id, { marginPct: margins[s.id] ?? s.marginPct })),
      );
      setStores(updated);
      setMessage('Rollout saved — per-store margins updated.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p>Loading stores…</p>;

  return (
    <div>
      <div className="card">
        <h2>Stores / Multi-store rollout</h2>
        <p className="muted">
          Set a margin % per store. The price preview updates automatically:
          price = cost × (1 + margin). Preview below uses a $1.00 demo cost.
        </p>
        {error && <p className="error">{error}</p>}
        {message && <p>{message}</p>}
      </div>

      <div className="grid two">
        {stores.map((s) => {
          const margin = margins[s.id] ?? s.marginPct;
          const preview = DEMO_COST * (1 + margin / 100);
          return (
            <div key={s.id} className="card">
              <h3>{s.name}</h3>
              <p className="muted">
                {s.address ?? ''} {s.commanderModel ? `· Commander ${s.commanderModel}` : ''}
              </p>
              <p>
                Status: <span className="badge">{s.status}</span>
              </p>
              <div className="field">
                <label htmlFor={`margin-${s.id}`}>Margin %</label>
                <input
                  id={`margin-${s.id}`}
                  type="number"
                  min={0}
                  max={200}
                  step={0.5}
                  value={margin}
                  onChange={(e) =>
                    setMargins((m) => ({ ...m, [s.id]: Number(e.target.value) }))
                  }
                />
              </div>
              <p>
                Auto price preview (cost ${DEMO_COST.toFixed(2)}):{' '}
                <strong>${preview.toFixed(2)}</strong>
              </p>
            </div>
          );
        })}
      </div>

      {stores.length === 0 && (
        <p className="muted">No stores configured yet.</p>
      )}

      <button className="primary" onClick={() => void handleSave()} disabled={saving || stores.length === 0}>
        {saving ? 'Saving…' : 'Save rollout'}
      </button>
    </div>
  );
}
