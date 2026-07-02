import { useState, useEffect, useRef } from 'react';
import {
  Search, RefreshCw, CheckCircle2, AlertCircle, XCircle,
  Printer, ClipboardList, ChevronRight, FileDown, CloudDownload, Mail
} from 'lucide-react';
import { Product, ProductionOrderRow } from '../../../shared/types';
import { BarcodePreview } from '../../single-barcode-generator/components/BarcodePreview';
import { PrintableLabelContainer } from '../../single-barcode-generator/components/PrintableLabelContainer';
import { SINGLE_BARCODE_CONFIG } from '../../single-barcode-generator/config';
import { downloadLabelsPdf } from '../../../shared/utilities/pdfExport';
import { DuplicateEANModal } from '../../../shared/components/DuplicateEANModal';
import {
  isEANUPCSelected,
  checkEANDuplicate,
  recordSessionDuplicate,
  hasSessionDuplicates,
  sendSessionDuplicateEmail,
} from '../../../shared/services/EANDuplicateService';
import { useSettings } from '../../../shared/contexts/SettingsContext';

// ---------- API helpers ----------

async function searchByCode(code: string): Promise<ProductionOrderRow[]> {
  const res = await fetch(`/api/production-order/search?code=${encodeURIComponent(code)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Search failed.');
  }
  return res.json();
}

async function updateMatch(id: number, userSku: string, rowSku: string): Promise<boolean> {
  const res = await fetch('/api/production-order/update-match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, user_sku: userSku, row_sku: rowSku }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Verification failed.');
  }
  const data = await res.json();
  return data.code_match as boolean;
}

async function searchExact(identifier: string): Promise<Product | null> {
  const res = await fetch('/api/barcode/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error searching "${identifier}".`);
  }
  return res.json();
}

// Strip trailing non-numeric suffix: "1030488R" → "1030488", "ABC-RED" → "ABC"
function stripSkuSuffix(sku: string): string {
  return sku.replace(/[^0-9]+$/i, '');
}

async function fetchProductBySku(sku: string): Promise<Product> {
  // Primary: exact match
  const primary = await searchExact(sku);
  if (primary) return primary;

  // Secondary: strip trailing alpha suffix and retry (e.g. "1030488R" → "1030488")
  const base = stripSkuSuffix(sku);
  if (base && base !== sku) {
    const secondary = await searchExact(base);
    if (secondary) return secondary;
  }

  throw new Error(`SKU "${sku}" not found in EasyEcomProductMaster (tried base "${base || sku}").`);
}

// ---------- Component ----------

export function ProductionOrderBarcodeForm() {
  const { settings } = useSettings();
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<{ imported: number; updated: number; failed: number } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [shortCode, setShortCode] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<ProductionOrderRow[]>([]);

  const [selectedRow, setSelectedRow] = useState<ProductionOrderRow | null>(null);
  const [userSku, setUserSku] = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [codeMatch, setCodeMatch] = useState<boolean | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Product data fetched from the products table (for barcode rendering)
  const [productData, setProductData] = useState<Product | null>(null);
  const [productLookupLoading, setProductLookupLoading] = useState(false);
  const [productLookupError, setProductLookupError] = useState<string | null>(null);

  // Allow empty string so the user can fully erase the field
  const [quantityStr, setQuantityStr] = useState<string>('1');
  const quantity = parseInt(quantityStr) || 0;
  const canPrint = !!selectedRow && !!productData && quantity > 0;

  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Duplicate EAN state
  const [duplicateModal, setDuplicateModal] = useState<{ ean: string; products: Product[] } | null>(null);
  const [sessionHasDuplicates, setSessionHasDuplicates] = useState<boolean>(() => hasSessionDuplicates());
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  // Auto-search on short code input with debounce
  useEffect(() => {
    const q = shortCode.trim();
    if (!q || q.length < 4) {
      setResults([]);
      setSelectedRow(null);
      setCodeMatch(null);
      setSearchError(null);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError(null);
      setSelectedRow(null);
      setCodeMatch(null);
      setUserSku('');
      try {
        const rows = await searchByCode(q);
        setResults(rows);
        if (rows.length === 1) {
          setSelectedRow(rows[0]);
          setQuantityStr(String(rows[0].order_quantity || 1));
        }
      } catch (err: any) {
        setSearchError(err.message || 'Search failed.');
        setResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 450);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [shortCode]);

  // When a row is selected, fetch the full product from the products table
  useEffect(() => {
    if (!selectedRow) {
      setProductData(null);
      setProductLookupError(null);
      return;
    }
    setProductLookupLoading(true);
    setProductData(null);
    setProductLookupError(null);
    fetchProductBySku(selectedRow.sku)
      .then(p => setProductData(p))
      .catch(err => setProductLookupError(err.message || `SKU "${selectedRow.sku}" not found in products table.`))
      .finally(() => setProductLookupLoading(false));
  }, [selectedRow?.id]);

  const selectRow = (row: ProductionOrderRow) => {
    setSelectedRow(row);
    setQuantityStr(String(row.order_quantity || 1));
    setCodeMatch(null);
    setVerifyError(null);
    setUserSku('');
  };

  const handleVerify = async () => {
    if (!selectedRow || !userSku.trim()) return;
    setVerifyLoading(true);
    setVerifyError(null);
    try {
      const match = await updateMatch(selectedRow.id, userSku.trim(), selectedRow.sku);
      setCodeMatch(match);
      setResults(prev => prev.map(r => r.id === selectedRow.id ? { ...r, code_match: match } : r));
      setSelectedRow(prev => prev ? { ...prev, code_match: match } : prev);
    } catch (err: any) {
      setVerifyError(err.message || 'Verification failed.');
    } finally {
      setVerifyLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncLoading(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const res = await fetch('/api/production-order/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed.');
      setSyncResult({ imported: data.imported ?? 0, updated: data.updated ?? 0, failed: data.failed ?? 0 });
    } catch (err: any) {
      setSyncError(err.message || 'Sync failed.');
    } finally {
      setSyncLoading(false);
    }
  };

  const handlePrint = async () => {
    if (!canPrint || !productData) return;

    const ean = productData.EANUPC;
    const useEAN = isEANUPCSelected(ean);

    if (useEAN) {
      try {
        const { isDuplicate, products: dupeProducts } = await checkEANDuplicate(ean!.trim(), productData.sku);
        if (isDuplicate) {
          recordSessionDuplicate({
            ean: ean!.trim(),
            affectedProducts: dupeProducts.map(p => ({ sku: p.sku, productName: p.product_name })),
            timestamp: new Date().toISOString(),
            module: 'Production Order Barcode',
          });
          setSessionHasDuplicates(true);
          setDuplicateModal({ ean: ean!.trim(), products: dupeProducts });
          return;
        }
      } catch (err) {
        console.error('[EAN Duplicate Check] Failed:', err);
        return;
      }
    }

    setTimeout(() => window.print(), 50);
  };

  const handleEndSession = async () => {
    setEmailSending(true);
    await sendSessionDuplicateEmail('Production Order Barcode');
    setEmailSending(false);
    setEmailSent(true);
    setTimeout(() => setEmailSent(false), 4000);
  };

  const handleDownloadPdfOnly = async () => {
    if (!canPrint || !pdfContainerRef.current || isPdfExporting) return;
    setIsPdfExporting(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
      await downloadLabelsPdf(
        pdfContainerRef.current,
        `PO_${selectedRow!.sku}_${date}.pdf`
      );
    } catch (err) {
      console.error('[PDF Export] Failed:', err);
    } finally {
      setIsPdfExporting(false);
    }
  };

  const printProduct = productData;
  const validEan = (v?: string) => { const s = v?.trim() ?? ''; return s !== '' && s !== '0' ? s : null; };
  const barcodeValue = productData
    ? (validEan(productData.EANUPC) ?? productData.sku?.trim() ?? '—')
    : '—';
  const hasSearched = shortCode.trim().length >= 4 && !searchLoading;

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">

      {/* Duplicate EAN session banner */}
      {sessionHasDuplicates && (
        <div className="bg-red-900/20 border border-red-500/30 rounded-xl px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-xs text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
            <span className="font-semibold">Duplicate EANs detected this session.</span>
            <span className="text-red-400/80">End session to send escalation email to {settings.eanDuplicateEmails.join(', ') || 'no recipients configured'}.</span>
          </div>
          <button
            onClick={handleEndSession}
            disabled={emailSending || emailSent}
            className="flex items-center gap-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition cursor-pointer shrink-0"
          >
            <Mail className="h-3.5 w-3.5" />
            {emailSent ? 'Email Sent!' : emailSending ? 'Sending…' : 'End Session & Report'}
          </button>
        </div>
      )}


      {/* Header & Search Panel */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="border-b border-slate-800/60 pb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-indigo-400" />
              Production Order Barcode
            </h1>
            <p className="text-slate-400 text-xs mt-1">
              Enter the last 4–5 digits of a reference code to find the order and print its barcode
            </p>
          </div>

          {/* Sync button */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            <button
              onClick={handleSync}
              disabled={syncLoading}
              className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-300 hover:text-white font-semibold px-3 py-2 rounded-xl text-xs transition cursor-pointer"
            >
              {syncLoading
                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                : <CloudDownload className="h-3.5 w-3.5" />}
              {syncLoading ? 'Syncing…' : 'Sync Sheet'}
            </button>
            {syncResult && !syncLoading && (
              <p className="text-[10px] text-emerald-400">
                +{syncResult.imported} new · {syncResult.updated} updated
                {syncResult.failed > 0 && <span className="text-amber-400"> · {syncResult.failed} failed</span>}
              </p>
            )}
            {syncError && !syncLoading && (
              <p className="text-[10px] text-red-400">{syncError}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block">
            Reference Code (last 4–5 digits)
          </label>
          <div className="relative max-w-sm">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-500" />
            </div>
            <input
              type="text"
              value={shortCode}
              onChange={e => setShortCode(e.target.value)}
              placeholder="e.g. 0042, 8731"
              maxLength={8}
              className="w-full bg-slate-950 border border-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-xl pl-10 pr-10 py-3 text-sm text-white placeholder-slate-500 font-medium transition"
            />
            {searchLoading && (
              <div className="absolute inset-y-0 right-0 pr-3.5 flex items-center">
                <RefreshCw className="h-4 w-4 text-indigo-400 animate-spin" />
              </div>
            )}
            {shortCode && !searchLoading && (
              <button
                onClick={() => { setShortCode(''); setResults([]); setSelectedRow(null); setCodeMatch(null); }}
                className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-500 hover:text-slate-300 text-xs cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
          {searchError && (
            <p className="text-xs text-red-400 flex items-center gap-1.5 mt-1">
              <AlertCircle className="h-3.5 w-3.5" /> {searchError}
            </p>
          )}
        </div>

        {/* Results list — shown when multiple matches */}
        {hasSearched && results.length > 1 && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              {results.length} orders found — select one
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
              {results.map(row => (
                <button
                  key={row.id}
                  onClick={() => selectRow(row)}
                  className={`text-left p-3 rounded-xl border transition cursor-pointer ${
                    selectedRow?.id === row.id
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-slate-800 bg-slate-950 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-200 truncate">{row.sku}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 truncate">{row.product_name || '—'}</div>
                  <div className="text-[10px] text-slate-600 font-mono mt-0.5">
                    Ref: {row.reference_code_original} · {row.import_date}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {hasSearched && results.length === 0 && (
          <p className="text-xs text-slate-500 flex items-center gap-1.5">
            <XCircle className="h-3.5 w-3.5 text-slate-600" />
            No orders found for "{shortCode.trim()}". Try syncing first or check the code.
          </p>
        )}
      </div>

      {/* Verification & Print Panel */}
      {selectedRow && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

          {/* Left: Order details + SKU verification */}
          <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
            <h2 className="text-md font-bold text-slate-200 pb-3 border-b border-slate-800/60">
              Order Details
            </h2>

            <div className="space-y-3 text-sm">
              <div>
                <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block">Reference Code</span>
                <span className="font-mono font-bold text-white">{selectedRow.reference_code_original}</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block">Order SKU</span>
                  <span className="font-mono font-bold text-indigo-300 text-base">{selectedRow.sku}</span>
                  {stripSkuSuffix(selectedRow.sku) !== selectedRow.sku && (
                    <span className="font-mono text-xs text-slate-400 block mt-0.5">
                      → {stripSkuSuffix(selectedRow.sku)}
                    </span>
                  )}
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block">Import Date</span>
                  <span className="text-white text-xs">{selectedRow.import_date || '—'}</span>
                </div>
              </div>
            </div>

            {/* Product lookup status */}
            {productLookupLoading && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                Looking up SKU in products table…
              </div>
            )}
            {productLookupError && (
              <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-xl text-xs font-semibold">
                <XCircle className="h-4 w-4 shrink-0" />
                {productLookupError}
              </div>
            )}
            {productData && (
              <div className="space-y-2 bg-slate-950/60 border border-slate-800/60 rounded-xl p-3">
                <p className="text-[10px] uppercase tracking-widest text-emerald-500 font-bold">Product Data (from EasyEcomProductMaster)</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-[10px] text-slate-500 block">Product Name</span>
                    <span className="text-white leading-snug">{productData.product_name || '—'}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">MRP</span>
                    <span className="text-white">{productData.mrp || '—'}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">EAN/UPC</span>
                    <span className="font-mono text-white">{productData.EANUPC || '—'}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Brand</span>
                    <span className="text-white">{productData.brand || '—'}</span>
                  </div>
                </div>
              </div>
            )}
            {/* SKU verification */}
            <div className="pt-3 border-t border-slate-800/60 space-y-3">
              <p className="text-xs text-slate-400">
                Enter the SKU you have physically and verify it matches the order.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={userSku}
                  onChange={e => { setUserSku(e.target.value); setCodeMatch(null); setVerifyError(null); }}
                  placeholder="Your SKU"
                  className="flex-1 bg-slate-950 border border-slate-800 focus:border-indigo-500 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 font-mono"
                />
                <button
                  onClick={handleVerify}
                  disabled={!userSku.trim() || verifyLoading}
                  className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-4 py-2 rounded-xl text-xs transition cursor-pointer"
                >
                  {verifyLoading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : 'Verify'}
                </button>
              </div>

              {verifyError && (
                <p className="text-xs text-red-400 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5" /> {verifyError}
                </p>
              )}
              {codeMatch === true && (
                <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-2 rounded-xl text-xs font-semibold">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  SKU matched — code_match saved as true
                </div>
              )}
              {codeMatch === false && (
                <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 text-amber-400 px-3 py-2 rounded-xl text-xs font-semibold">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  SKU mismatch — using DB SKU for barcode, code_match saved as false
                </div>
              )}
            </div>

            {/* Quantity + Print + PDF */}
            <div className="pt-3 border-t border-slate-800/60 space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block">Print Quantity</label>
                <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-2 w-36">
                  <button
                    type="button"
                    onClick={() => setQuantityStr(q => String(Math.max(1, (parseInt(q) || 1) - 1)))}
                    className="text-slate-400 hover:text-white p-2.5 hover:bg-slate-900 rounded-lg font-bold transition cursor-pointer"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min="1"
                    max={SINGLE_BARCODE_CONFIG.limits.maxQuantity}
                    value={quantityStr}
                    onChange={e => {
                      const raw = e.target.value;
                      if (raw === '') { setQuantityStr(''); return; }
                      const n = parseInt(raw);
                      if (!isNaN(n)) setQuantityStr(String(Math.min(SINGLE_BARCODE_CONFIG.limits.maxQuantity, Math.max(1, n))));
                    }}
                    className="w-full bg-transparent text-center text-sm font-semibold text-white focus:outline-none py-2.5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <button
                    type="button"
                    onClick={() => setQuantityStr(q => String(Math.min(SINGLE_BARCODE_CONFIG.limits.maxQuantity, (parseInt(q) || 0) + 1)))}
                    className="text-slate-400 hover:text-white p-2.5 hover:bg-slate-900 rounded-lg font-bold transition cursor-pointer"
                  >
                    +
                  </button>
                </div>
                {!canPrint && quantityStr !== '' && quantity === 0 && (
                  <p className="text-[10px] text-amber-400">Enter a quantity greater than 0 to print.</p>
                )}
                {quantityStr === '' && (
                  <p className="text-[10px] text-amber-400">Enter a quantity to enable printing.</p>
                )}
              </div>

              <button
                onClick={handlePrint}
                disabled={!canPrint}
                className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-xl transition text-sm cursor-pointer"
              >
                <Printer className="h-4 w-4" /> Print {quantity > 0 ? quantity : ''} Label{quantity !== 1 ? 's' : ''}
              </button>

              <button
                type="button"
                onClick={handleDownloadPdfOnly}
                disabled={!canPrint || isPdfExporting}
                className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-300 hover:text-white font-semibold py-3 px-4 rounded-xl transition text-sm cursor-pointer"
              >
                {isPdfExporting ? (
                  <><RefreshCw className="h-4 w-4 animate-spin" /> Generating PDF...</>
                ) : (
                  <><FileDown className="h-4 w-4" /> Download PDF</>
                )}
              </button>
            </div>
          </div>

          {/* Right: Barcode Preview */}
          <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex justify-between items-center pb-3 border-b border-slate-800/60">
              <h2 className="text-md font-bold text-slate-200">Label Preview (50mm × 30mm)</h2>
              {quantity > 0 && (
                <span className="text-xs font-semibold bg-indigo-500/10 border border-indigo-500/25 text-indigo-400 py-1 px-2.5 rounded-lg">
                  Shows 1 of {quantity}
                </span>
              )}
            </div>

            <div className="bg-slate-950 border border-slate-800/60 rounded-xl p-8 flex items-center justify-center min-h-48">
              {productLookupLoading ? (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <RefreshCw className="h-4 w-4 animate-spin text-indigo-400" />
                  Loading product…
                </div>
              ) : printProduct ? (
                <div className="hover:ring-2 hover:ring-indigo-500 p-2 bg-white rounded-md transition shadow-2xl">
                  <BarcodePreview product={printProduct} scale={1.5} useStrippedSku />
                </div>
              ) : productLookupError ? (
                <div className="text-center text-red-400 text-xs px-4">
                  <XCircle className="h-6 w-6 mx-auto mb-2 opacity-50" />
                  Cannot render barcode — SKU not in products table
                </div>
              ) : (
                <div className="text-center text-slate-600 text-xs">Select an order to preview label</div>
              )}
            </div>

            <div className="text-xs text-slate-600 text-center">
              Barcode value: <span className="font-mono text-slate-400">{barcodeValue}</span>
            </div>
          </div>
        </div>
      )}

      {/* Off-screen PDF capture container */}
      {printProduct && quantity > 0 && (
        <div
          ref={pdfContainerRef}
          style={{ position: 'fixed', left: '-9999px', top: 0, background: '#fff', pointerEvents: 'none' }}
          aria-hidden="true"
        >
          {Array.from({ length: quantity }).map((_, i) => (
            <div key={i} className="print-label-item" style={{ width: '50mm', height: '30mm' }}>
              <BarcodePreview product={printProduct} scale={1.0} useStrippedSku />
            </div>
          ))}
        </div>
      )}

      {/* Native print portal */}
      {printProduct && quantity > 0 && (
        <PrintableLabelContainer product={printProduct} quantity={quantity} />
      )}

      {/* Duplicate EAN blocking modal */}
      {duplicateModal && (
        <DuplicateEANModal
          ean={duplicateModal.ean}
          products={duplicateModal.products}
          onClose={() => setDuplicateModal(null)}
        />
      )}
    </div>
  );
}
