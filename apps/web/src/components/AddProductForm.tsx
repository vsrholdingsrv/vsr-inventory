import { useState } from 'react';
import { createProduct, type Product } from '../api';

/**
 * Add a product that isn't in the catalog yet — e.g. after scanning an
 * unknown barcode. The barcode is prefilled when the caller scanned one.
 * The product is created AND stocked at the home store in one call, so it
 * can be scanned and sold right away (creating a catalog row alone used
 * to leave it invisible to Scan).
 */
export default function AddProductForm({
  barcode: initialBarcode = '',
  onAdded,
  onCancel,
}: {
  barcode?: string;
  onAdded: (product: Product) => void;
  onCancel?: () => void;
}) {
  const [barcode, setBarcode] = useState(initialBarcode);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [cost, setCost] = useState('');
  const [price, setPrice] = useState('');
  const [par, setPar] = useState('12');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    const costNum = Number(cost);
    const priceNum = price === '' ? undefined : Number(price);
    if (!barcode.trim()) {
      setError('Enter a barcode.');
      return;
    }
    if (!name.trim()) {
      setError('Enter a product name.');
      return;
    }
    if (!Number.isFinite(costNum) || costNum < 0) {
      setError('Enter a valid cost (0 or more).');
      return;
    }
    if (priceNum !== undefined && (!Number.isFinite(priceNum) || priceNum < 0)) {
      setError('Enter a valid price (0 or more), or leave it blank to use cost + 30% margin.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const product = await createProduct({
        barcode: barcode.trim(),
        name: name.trim(),
        category: category.trim() || undefined,
        cost: costNum,
        price: priceNum,
        marginPct: priceNum === undefined ? 30 : undefined,
        par: Number(par) || 0,
      });
      onAdded(product);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the product.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Add a new product</h2>
      <p className="muted">
        This barcode isn&apos;t in the catalog yet. Fill in the details and it will be added and
        stocked at the home store, ready to scan and sell.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="field">
        <label htmlFor="add-barcode">Barcode</label>
        <input
          id="add-barcode"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          placeholder="e.g. 082184000342"
          inputMode="numeric"
        />
      </div>
      <div className="field">
        <label htmlFor="add-name">Product name</label>
        <input
          id="add-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Coca-Cola 20oz"
        />
      </div>
      <div className="field">
        <label htmlFor="add-category">Category (optional)</label>
        <input
          id="add-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="e.g. Beverages"
        />
      </div>
      <div className="grid two">
        <div className="field">
          <label htmlFor="add-cost">Cost ($)</label>
          <input
            id="add-cost"
            type="number"
            min={0}
            step={0.01}
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="1.10"
          />
        </div>
        <div className="field">
          <label htmlFor="add-price">Price ($, optional)</label>
          <input
            id="add-price"
            type="number"
            min={0}
            step={0.01}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Blank = cost + 30%"
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="add-par">Par level (units)</label>
        <input
          id="add-par"
          type="number"
          min={0}
          value={par}
          onChange={(e) => setPar(e.target.value)}
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary" onClick={() => void handleSubmit()} disabled={busy}>
          {busy ? 'Adding…' : 'Add product'}
        </button>
        {onCancel && (
          <button className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
