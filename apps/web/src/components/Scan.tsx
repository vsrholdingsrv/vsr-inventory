import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { DecodeHintType } from '@zxing/library';
import { getProductByBarcode, postSale, type Product } from '../api';
import AddProductForm from './AddProductForm';

/** Demo barcodes. Coke's check digit is valid; Snickers / Pepsi are demo values. */
const DEMO_BARCODES = [
  { label: 'Coke 049000050103', barcode: '049000050103' },
  { label: 'Snickers 040000001017', barcode: '040000001017' },
  { label: 'Pepsi 012000000927', barcode: '012000000927' },
];

export default function Scan() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const [unknownBarcode, setUnknownBarcode] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function getReader(): BrowserMultiFormatReader {
    if (!readerRef.current) {
      const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
      readerRef.current = new BrowserMultiFormatReader(hints);
    }
    return readerRef.current;
  }

  async function startCamera() {
    setError(null);
    setMessage(null);
    const video = videoRef.current;
    if (!video) return;
    setScanning(true);
    try {
      controlsRef.current = await getReader().decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        video,
        (result, err) => {
          if (result) {
            void lookup(result.getText());
            void stopCamera();
          } else if (err && err.name !== 'NotFoundException') {
            setError(err.message);
          }
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Camera could not be started.');
      setScanning(false);
    }
  }

  async function stopCamera() {
    try {
      controlsRef.current?.stop();
    } catch {
      // Scanner was never started; nothing to stop.
    }
    controlsRef.current = null;
    setScanning(false);
  }

  useEffect(() => {
    return () => {
      try {
        controlsRef.current?.stop();
      } catch {
        // Ignore cleanup errors.
      }
    };
  }, []);

  async function lookup(barcode: string) {
    const code = barcode.trim();
    if (!code) return;
    setError(null);
    setMessage(null);
    setUnknownBarcode(null);
    setBusy(true);
    try {
      const p = await getProductByBarcode(code);
      setProduct(p);
      setQty(1);
    } catch (e) {
      setProduct(null);
      // Unknown barcode: offer to add the product instead of a dead end.
      setUnknownBarcode(code);
      setError(e instanceof Error ? e.message : `No product found for ${code}.`);
    } finally {
      setBusy(false);
    }
  }

  /** Photo fallback: decode a barcode from an uploaded image of the barcode. */
  async function handlePhoto(file: File) {
    setError(null);
    setMessage(null);
    const url = URL.createObjectURL(file);
    try {
      const result = await getReader().decodeFromImageUrl(url);
      await lookup(result.getText());
    } catch {
      setError('Could not read a barcode from that photo. Try a closer, well-lit shot or enter the code manually.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function handleSale() {
    if (!product) return;
    const sellQty = Math.min(qty, product.onHand);
    if (sellQty <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await postSale({ barcode: product.barcode, qty: sellQty });
      setProduct(res.product);
      setMessage(`Sold ${sellQty} × ${product.name}. Transaction total $${res.transactionTotal.toFixed(2)}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sale failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Scan a product</h2>
        <video ref={videoRef} className="scan-video" muted playsInline />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {!scanning ? (
            <button className="primary" onClick={() => void startCamera()}>
              Start camera scan
            </button>
          ) : (
            <button className="secondary" onClick={() => void stopCamera()}>
              Stop camera
            </button>
          )}
          <label className="secondary" style={{ cursor: 'pointer' }}>
            Photo of barcode
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handlePhoto(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="manual-barcode">Or enter a barcode manually</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="manual-barcode"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="e.g. 049000050103"
              inputMode="numeric"
            />
            <button className="secondary" onClick={() => void lookup(manual)} disabled={busy}>
              Look up
            </button>
          </div>
        </div>

        <div>
          <span className="muted">Demo barcodes: </span>
          {DEMO_BARCODES.map((d) => (
            <button
              key={d.barcode}
              className="chip"
              onClick={() => {
                setManual(d.barcode);
                void lookup(d.barcode);
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {message && <p>{message}</p>}

      {unknownBarcode && !product && (
        <AddProductForm
          barcode={unknownBarcode}
          onAdded={(p) => {
            setUnknownBarcode(null);
            setProduct(p);
            setQty(1);
            setError(null);
            setMessage(`${p.name} added — ready to scan and sell. Receive stock first if on hand is 0.`);
          }}
          onCancel={() => setUnknownBarcode(null)}
        />
      )}

      {product && (
        <div className="card">
          <h2>{product.name}</h2>
          <p className="muted">
            {product.sku} · {product.barcode}
          </p>
          <div className="grid two">
            <div>
              <span className="muted">On hand</span>
              <p className="stat">{product.onHand}</p>
            </div>
            <div>
              <span className="muted">Price / Cost</span>
              <p className="stat">
                ${product.price.toFixed(2)} / ${product.cost.toFixed(2)}
              </p>
            </div>
            <div>
              <span className="muted">Location</span>
              <p>{product.location}</p>
            </div>
            <div>
              <span className="muted">Reorder point / Par</span>
              <p>
                {product.reorderPoint} / {product.par}
              </p>
            </div>
          </div>

          <div className="field">
            <label htmlFor="sale-qty">Quantity (capped at on-hand: {product.onHand})</label>
            <input
              id="sale-qty"
              type="number"
              min={1}
              max={product.onHand}
              value={qty}
              onChange={(e) => {
                const n = Number(e.target.value);
                setQty(Number.isFinite(n) ? Math.max(1, Math.min(n, product.onHand)) : 1);
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" onClick={() => void handleSale()} disabled={busy || product.onHand <= 0}>
              Sale
            </button>
            <button
              className="secondary"
              onClick={() => setMessage(`${product.name}: ${product.onHand} on hand at ${product.location}.`)}
            >
              Check stock
            </button>
          </div>
          {product.onHand <= 0 && <p className="alert-out">Out of stock — sale is blocked until stock is received.</p>}
        </div>
      )}
    </div>
  );
}
