import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  RefreshCw, Terminal, AlertTriangle, CheckCircle2, XCircle,
  ShieldAlert, Inbox, FileSpreadsheet, Lock, Unlock,
  ClipboardCheck, Sparkles, Search,
} from 'lucide-react';
import { Product } from '../../../shared/types';
import { BarcodePreview } from '../../single-barcode-generator/components/BarcodePreview';
import { generateShipmentBatchNo } from '../../../shared/utilities/batchNo';

// ── Local types ──────────────────────────────────────────────────────────────

interface POLine {
  id?: number;
  po_ref_num: string;
  po_id?: string;
  sku: string;
  original_quantity: number;
  pending_quantity: number;
  item_price?: number;
}

interface ScanTapeEntry {
  sku: string;
  name: string;
  timestamp: string;
  isExcess: boolean;
}

interface NoProductEntry {
  value: string;
  timestamp: string;
  reason: string;
}

type SyncState =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'success'; message: string }
  | { type: 'error'; message: string };

type ScanStatusState = {
  type: 'idle' | 'success' | 'warning' | 'error' | 'processing';
  message: string;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function ShipmentBarcodeForm() {
  // PO selection
  const [poRefNumInput, setPoRefNumInput]     = useState('');
  const [activePoRefNum, setActivePoRefNum]   = useState<string | null>(null);
  const [poLines, setPoLines]                 = useState<POLine[]>([]);
  const [poLinesLoading, setPoLinesLoading]   = useState(false);
  const [availableRefNums, setAvailableRefNums] = useState<string[]>([]);
  const [showRefNumList, setShowRefNumList]   = useState(false);

  // Sync
  const [syncState, setSyncState] = useState<SyncState>({ type: 'idle' });

  // Session state (frontend-only — no DB write for scans)
  const [countingQty, setCountingQty]           = useState<Record<string, number>>({});
  const [productCache, setProductCache]         = useState<Record<string, Product>>({});
  const [excessQtyFrequency, setExcessQtyFrequency] = useState<Record<string, number>>({});
  const [noProductData, setNoProductData]       = useState<NoProductEntry[]>([]);
  const [scanTape, setScanTape]                 = useState<ScanTapeEntry[]>([]);
  const [activePrintBatch, setActivePrintBatch] = useState<Array<{ product: Product }>>([]);
  const [locked, setLocked]                     = useState(false);

  // Scan input
  const [scanMode, setScanMode] = useState<'autofocus' | 'manual'>(() => {
    const v = localStorage.getItem('shipment_scan_mode');
    return v === 'autofocus' || v === 'manual' ? v : 'autofocus';
  });
  const [barcodeInput, setBarcodeInput] = useState('');
  const [scanStatus, setScanStatus]     = useState<ScanStatusState>({
    type: 'idle',
    message: 'Load a PO Ref Num to begin scanning.',
  });

  // Refs

  const inputRef           = useRef<HTMLInputElement>(null);
  const autoScanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const poDebounceRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Init: load available PO ref nums ──────────────────────────────────────

  useEffect(() => {
    fetch('/api/shipment/po-ref-nums')
      .then(r => r.json())
      .then((data: string[]) => { if (Array.isArray(data)) setAvailableRefNums(data); })
      .catch(() => {});
  }, []);

  // ── Scan mode persistence ─────────────────────────────────────────────────

  useEffect(() => {
    localStorage.setItem('shipment_scan_mode', scanMode);
    setScanStatus({
      type: 'idle',
      message: scanMode === 'autofocus'
        ? 'Continuous Auto-Focus active. Scan barcodes with your laser scanner.'
        : 'Manual & Focus-Free mode active. Type or scan anywhere on-screen.',
    });
  }, [scanMode]);

  // ── PO ref num debounce load ──────────────────────────────────────────────

  useEffect(() => {
    const q = poRefNumInput.trim();
    if (!q) {
      setActivePoRefNum(null);
      setPoLines([]);
      return;
    }
    if (poDebounceRef.current) clearTimeout(poDebounceRef.current);
    poDebounceRef.current = setTimeout(() => loadPOLines(q), 350);
    return () => { if (poDebounceRef.current) clearTimeout(poDebounceRef.current); };
  }, [poRefNumInput]);

  const loadPOLines = async (refNum: string) => {
    setPoLinesLoading(true);
    try {
      const res = await fetch(`/api/shipment/po-lines?po_ref_num=${encodeURIComponent(refNum)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load PO lines.');
      const lines: POLine[] = await res.json();
      setPoLines(lines);
      setActivePoRefNum(refNum);
      resetSession();
      setScanStatus({ type: 'idle', message: `PO "${refNum}" loaded — ${lines.length} line${lines.length !== 1 ? 's' : ''}. Ready to scan.` });
    } catch (err: any) {
      setPoLines([]);
      setActivePoRefNum(null);
      setScanStatus({ type: 'error', message: err.message || 'Failed to load PO lines.' });
    } finally {
      setPoLinesLoading(false);
    }
  };

  const resetSession = () => {
    setCountingQty({});
    setExcessQtyFrequency({});
    setNoProductData([]);
    setScanTape([]);
    setActivePrintBatch([]);
    setLocked(false);
  };

  // ── Auto-focus loop ───────────────────────────────────────────────────────

  useEffect(() => {
    if (locked || scanMode !== 'autofocus' || !activePoRefNum) return;
    const interval = setInterval(() => {
      if (document.activeElement !== inputRef.current && inputRef.current) {
        inputRef.current.focus();
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [locked, scanMode, activePoRefNum]);

  // ── Auto-trigger scan in autofocus mode ───────────────────────────────────

  useEffect(() => {
    if (scanMode !== 'autofocus' || !barcodeInput.trim()) {
      if (autoScanTimeoutRef.current) { clearTimeout(autoScanTimeoutRef.current); autoScanTimeoutRef.current = null; }
      return;
    }
    if (autoScanTimeoutRef.current) clearTimeout(autoScanTimeoutRef.current);
    autoScanTimeoutRef.current = setTimeout(() => {
      const val = barcodeInput.trim();
      if (val) { setBarcodeInput(''); executeBarcodeScan(val); }
    }, 200);
    return () => { if (autoScanTimeoutRef.current) clearTimeout(autoScanTimeoutRef.current); };
  }, [barcodeInput, scanMode]);

  // ── Global keydown for manual focus-free mode ─────────────────────────────

  useEffect(() => {
    if (locked || scanMode !== 'manual' || !activePoRefNum) return;
    let buffer = '';
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
        if (el !== inputRef.current) return;
      }
      if (['Tab','Escape','Shift','Control','Alt','Meta','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End'].includes(e.key)) return;
      // Ignore Ctrl/Cmd combos (Ctrl+V paste, Ctrl+C copy, etc.) — let paste event handle them
      if (e.ctrlKey || e.metaKey) return;
      if (e.key === 'Backspace') { e.preventDefault(); buffer = buffer.slice(0, -1); setBarcodeInput(buffer); return; }
      if (e.key === 'Enter') {
        const trimmed = buffer.trim();
        if (trimmed) { e.preventDefault(); executeBarcodeScan(trimmed); }
        buffer = ''; setBarcodeInput(''); return;
      }
      if (e.key.length === 1) {
        if (e.key === ' ') e.preventDefault();
        buffer += e.key; setBarcodeInput(buffer);
      }
    };
    const pasteHandler = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') || '';
      if (!text.trim()) return;
      e.preventDefault();
      buffer = text.trim(); setBarcodeInput(buffer);
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('paste', pasteHandler);
    return () => { window.removeEventListener('keydown', handler); window.removeEventListener('paste', pasteHandler); };
  }, [locked, scanMode, activePoRefNum, poLines, excessQtyFrequency]);

  // ── Auto print when activePrintBatch is set ───────────────────────────────

  useEffect(() => {
    if (!activePrintBatch.length) return;
    const timer = setTimeout(() => {
      window.print();
      setTimeout(() => setActivePrintBatch([]), 800);
    }, 500);
    return () => clearTimeout(timer);
  }, [activePrintBatch]);

  // ── Sync ─────────────────────────────────────────────────────────────────

  const handlePOSync = async (demo = false) => {
    setSyncState({ type: 'loading' });
    try {
      const res = await fetch('/api/shipment/po-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed.');
      setSyncState({
        type: 'success',
        message: `PO Headers Inserted: ${data.headersInserted} / Updated: ${data.headersUpdated} · Lines Inserted: ${data.linesInserted} / Updated: ${data.linesUpdated}`,
      });
      // Refresh available ref nums
      fetch('/api/shipment/po-ref-nums')
        .then(r => r.json())
        .then((d: string[]) => { if (Array.isArray(d)) setAvailableRefNums(d); })
        .catch(() => {});
      setTimeout(() => setSyncState({ type: 'idle' }), 8000);
    } catch (err: any) {
      setSyncState({ type: 'error', message: err.message || 'Sync failed.' });
    }
  };

  // ── Core scan engine ──────────────────────────────────────────────────────

  const executeBarcodeScan = async (cleanValue: string) => {
    if (!cleanValue || !activePoRefNum) return;
    setScanStatus({ type: 'processing', message: `Querying: "${cleanValue}"` });

    try {
      const res = await fetch('/api/barcode/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: cleanValue }),
      });

      if (res.status === 404) {
        // Case 1 or Case 3: not in EasyEcomProductMaster
        const isInPO = poLines.some(l => l.sku.toLowerCase() === cleanValue.toLowerCase());
        const reason = isInPO ? 'Missing Product Master Data' : 'Unknown SKU';
        setNoProductData(prev => [{ value: cleanValue, timestamp: new Date().toLocaleTimeString(), reason }, ...prev]);
        setScanStatus({ type: 'error', message: `${reason}: "${cleanValue}" — cannot print label.` });
        return;
      }

      if (!res.ok) throw new Error(`Server error HTTP ${res.status}`);

      const product: Product = await res.json();

      // Cache product for display in summary / tables
      setProductCache(prev => ({ ...prev, [product.sku]: product }));

      const poLine = poLines.find(l => l.sku.toLowerCase() === product.sku.toLowerCase());

      if (poLine) {
        // Matched PO line — increment and always print
        const nextCount = (countingQty[product.sku] || 0) + 1;
        setCountingQty(prev => ({ ...prev, [product.sku]: nextCount }));

        const isExcess = nextCount > poLine.original_quantity;
        if (isExcess) {
          setExcessQtyFrequency(prev => ({ ...prev, [product.sku]: nextCount - poLine.original_quantity }));
        }

        setScanTape(prev => [{ sku: product.sku, name: product.product_name, timestamp: new Date().toLocaleTimeString(), isExcess }, ...prev]);

        setActivePrintBatch([{ product }]);

        setScanStatus({
          type: isExcess ? 'warning' : 'success',
          message: isExcess
            ? `EXCESS: [${product.sku}] ${product.product_name} — received ${nextCount}, ordered ${poLine.original_quantity}. Label printed.`
            : `RECEIVED: [${product.sku}] ${product.product_name}. Label sent to printer.`,
        });
      } else {
        // Case 2: found in EasyEcomProductMaster but NOT in active PO — excess inventory
        const nextExcess = (excessQtyFrequency[product.sku] || 0) + 1;
        setExcessQtyFrequency(prev => ({ ...prev, [product.sku]: nextExcess }));

        setScanTape(prev => [{ sku: product.sku, name: product.product_name, timestamp: new Date().toLocaleTimeString(), isExcess: true }, ...prev]);

        setActivePrintBatch([{ product }]);

        setScanStatus({
          type: 'warning',
          message: `UNEXPECTED: [${product.sku}] ${product.product_name} not in active PO. Treating as excess — label printed.`,
        });
      }
    } catch (err: any) {
      setScanStatus({ type: 'error', message: `Query failed: ${err.message || 'Database unavailable'}` });
    }
  };

  const handleBarcodeScan = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const val = barcodeInput.trim();
    if (!val) return;
    setBarcodeInput('');
    await executeBarcodeScan(val);
  };

  // ── Export WMS report ─────────────────────────────────────────────────────

  const handleExportWMSReport = () => {
    const rows: string[][] = [['Section', 'SKU', 'Product Name', 'Ordered Qty', 'Received Qty', 'Excess Qty', 'Notes']];

    for (const line of poLines) {
      const received = countingQty[line.sku] || 0;
      const excess   = Math.max(0, received - line.original_quantity);
      if (received > 0 || excess > 0) {
        const name = productCache[line.sku]?.product_name || '';
        rows.push(['PO LINE', line.sku, `"${name.replace(/"/g,'""')}"`,
          line.original_quantity.toString(), received.toString(), excess.toString(), '']);
      }
    }

    for (const sku of Object.keys(excessQtyFrequency)) {
      if (poLines.some(l => l.sku.toLowerCase() === sku.toLowerCase())) continue;
      const name = productCache[sku]?.product_name || 'Unexpected SKU';
      rows.push(['UNEXPECTED', sku, `"${name.replace(/"/g,'""')}"`,
        '0', '0', excessQtyFrequency[sku].toString(), 'Not in active PO']);
    }

    for (const entry of noProductData) {
      rows.push(['NO PRODUCT DATA', `"${entry.value.replace(/"/g,'""')}"`, '"—"',
        '0', '0', '0', `"${entry.reason} @ ${entry.timestamp}"`]);
    }

    const csv = 'data:text/csv;charset=utf-8,' + rows.map(r => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = encodeURI(csv);
    a.download = `WMS_Report_${activePoRefNum || 'PO'}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  // ── Derived stats ─────────────────────────────────────────────────────────

  const poLinesCompleted = poLines.filter(l => (countingQty[l.sku] || 0) >= l.original_quantity).length;

  // Active table: only rows with at least one scan
  const activeRows = poLines.filter(l => (countingQty[l.sku] || 0) > 0);

  // Summary excess table
  const allExcessEntries = Object.keys(excessQtyFrequency).map(sku => ({
    sku,
    excessQty: excessQtyFrequency[sku],
    productName: productCache[sku]?.product_name || (poLines.find(l => l.sku === sku)?.sku || sku),
  }));

  return (
    <div className="flex flex-col gap-2.5">

      {/* ── Compact Header Bar ── */}
      <div className="flex items-center justify-between bg-slate-900 border border-slate-800 px-4 py-2.5 rounded-xl gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[9px] uppercase bg-amber-500/10 border border-amber-500/30 text-amber-400 px-2 py-0.5 rounded font-bold tracking-wider">Inbound</span>
            <span className="text-[9px] uppercase bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 px-2 py-0.5 rounded font-bold tracking-wider">PO Mode</span>
          </div>
          <h1 className="text-sm font-bold tracking-tight text-white whitespace-nowrap">Shipment Barcode Receiving</h1>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {syncState.type !== 'idle' && (
            <div className={`flex items-center gap-1 text-[10px] max-w-xs ${
              syncState.type === 'error' ? 'text-red-400' :
              syncState.type === 'success' ? 'text-emerald-400' : 'text-indigo-400'
            }`}>
              {syncState.type === 'error'   && <XCircle      className="h-3 w-3 shrink-0" />}
              {syncState.type === 'success' && <CheckCircle2 className="h-3 w-3 shrink-0" />}
              {syncState.type === 'loading' && <RefreshCw    className="h-3 w-3 shrink-0 animate-spin" />}
              <span className="truncate">{syncState.type === 'loading' ? 'Syncing…' : (syncState as any).message}</span>
            </div>
          )}
          <button
            onClick={() => handlePOSync(true)}
            disabled={syncState.type === 'loading'}
            className="text-indigo-400 hover:text-indigo-300 text-[10px] font-bold underline cursor-pointer disabled:opacity-50 select-none whitespace-nowrap"
          >
            Load demo
          </button>
          <button
            onClick={() => handlePOSync(false)}
            disabled={syncState.type === 'loading'}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[11px] font-semibold py-1.5 px-3 rounded-lg transition cursor-pointer select-none whitespace-nowrap"
          >
            <RefreshCw className={`h-3 w-3 ${syncState.type === 'loading' ? 'animate-spin' : ''}`} />
            Sync POs
          </button>
        </div>
      </div>

      {/* ── PO Selector (compact single row) ── */}
      <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5">
        <div className="relative flex-shrink-0 w-72">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-3.5 w-3.5 text-slate-300" />
          </div>
          <input
            type="text"
            value={poRefNumInput}
            onChange={e => { setPoRefNumInput(e.target.value); setShowRefNumList(true); }}
            onFocus={() => setShowRefNumList(true)}
            onBlur={() => setTimeout(() => setShowRefNumList(false), 150)}
            placeholder="e.g. VS-PW260515-1"
            className="w-full bg-slate-950 border border-slate-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 font-mono transition"
          />
          {showRefNumList && availableRefNums.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 z-20 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl max-h-48 overflow-y-auto">
              {availableRefNums
                .filter(r => !poRefNumInput || r.toLowerCase().includes(poRefNumInput.toLowerCase()))
                .map(ref => (
                  <button
                    key={ref}
                    onMouseDown={() => { setPoRefNumInput(ref); setShowRefNumList(false); }}
                    className="w-full text-left px-4 py-2 text-xs font-mono text-slate-300 hover:bg-slate-800 hover:text-white transition cursor-pointer"
                  >
                    {ref}
                  </button>
                ))}
            </div>
          )}
        </div>

        {poLinesLoading && <RefreshCw className="h-3.5 w-3.5 text-indigo-400 animate-spin shrink-0" />}

        {activePoRefNum && !poLinesLoading && (
          <div className="flex items-center gap-2 text-xs">
            <span className="bg-indigo-500/10 border border-indigo-500/25 text-indigo-300 px-2.5 py-1 rounded-lg font-bold font-mono whitespace-nowrap">
              {activePoRefNum}
            </span>
            <span className="text-slate-400 whitespace-nowrap">{poLines.length} line{poLines.length !== 1 ? 's' : ''}</span>
            {poLines.length > 0 && poLinesCompleted === poLines.length && (
              <span className="bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap">All done</span>
            )}
          </div>
        )}
      </div>

      {/* ── Main workspace ── */}
      {!locked ? (
        <div className="flex flex-col gap-2.5">

          {/* Scan Input — accent pop */}
          <div className="bg-indigo-600 rounded-2xl p-4 shadow-xl space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2 select-none">
                <Terminal className="h-3.5 w-3.5" />
                Barcode Scanner
              </h2>
              <div className="inline-flex rounded-lg bg-indigo-700 p-0.5">
                {(['autofocus', 'manual'] as const).map(m => (
                  <button key={m} type="button" onClick={() => setScanMode(m)}
                    className={`px-3 py-1 text-[10px] font-bold rounded-md transition cursor-pointer ${
                      scanMode === m ? 'bg-white text-indigo-700 shadow' : 'text-indigo-200 hover:text-white'
                    }`}
                  >
                    {m === 'autofocus' ? '🎯 Auto-Focus' : '✏️ Manual'}
                  </button>
                ))}
              </div>
            </div>

            <form onSubmit={handleBarcodeScan} className="relative">
              <input
                ref={inputRef}
                type="text"
                value={barcodeInput}
                onChange={e => setBarcodeInput(e.target.value)}
                disabled={!activePoRefNum}
                placeholder={
                  !activePoRefNum
                    ? 'SELECT A PO REF NUM ABOVE TO BEGIN SCANNING...'
                    : scanMode === 'autofocus'
                      ? '🎯 AUTO-FOCUS ACTIVE — SCAN BARCODES DIRECTLY...'
                      : '✏️ TYPE SKU OR SCAN ANYWHERE — PRESS ENTER TO SUBMIT...'
                }
                className="w-full bg-indigo-900 border-2 border-indigo-400/40 focus:border-white rounded-xl px-4 py-3.5 text-sm font-mono tracking-widest text-white placeholder:text-indigo-300/60 focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-40 transition text-center uppercase caret-white"
              />
              {scanMode === 'manual' && activePoRefNum && (
                <button type="submit" className="absolute right-3 top-1/2 -translate-y-1/2 py-1.5 px-3 bg-white hover:bg-indigo-50 text-indigo-700 rounded-lg text-[10px] font-bold tracking-wide cursor-pointer">
                  Scan
                </button>
              )}
            </form>

            <div className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-2 select-none ${
              scanStatus.type === 'error'      ? 'bg-red-500/20 border-red-300/20 text-red-200' :
              scanStatus.type === 'success'    ? 'bg-emerald-500/20 border-emerald-300/20 text-emerald-200' :
              scanStatus.type === 'warning'    ? 'bg-amber-500/20 border-amber-300/20 text-amber-200' :
              scanStatus.type === 'processing' ? 'bg-indigo-500/30 border-indigo-300/20 text-indigo-100' :
              'bg-indigo-700/50 border-indigo-400/20 text-indigo-200'
            }`}>
              {scanStatus.type === 'error'      && <XCircle       className="h-3.5 w-3.5 shrink-0" />}
              {scanStatus.type === 'success'    && <CheckCircle2  className="h-3.5 w-3.5 shrink-0" />}
              {scanStatus.type === 'warning'    && <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
              {scanStatus.type === 'processing' && <RefreshCw     className="h-3.5 w-3.5 shrink-0 animate-spin" />}
              {scanStatus.type === 'idle'       && <Terminal      className="h-3.5 w-3.5 shrink-0 text-indigo-300" />}
              <span className="font-medium">{scanStatus.message}</span>
            </div>
          </div>

          {/* Active Shipment Table + Scan Tape */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5">

            {/* Active Shipment Table */}
            <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3 select-none">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
                  <h2 className="text-xs font-bold text-slate-100 uppercase tracking-wider">Active Shipment</h2>
                </div>
                {activePoRefNum && poLines.length > 0 && (
                  <span className="text-[10px] font-bold text-slate-400">
                    {activeRows.length} / {poLines.length} scanned
                  </span>
                )}
              </div>

              {!activePoRefNum ? (
                <div className="flex flex-col items-center justify-center py-10 text-center space-y-2 select-none">
                  <Inbox className="h-7 w-7 text-slate-700" />
                  <p className="text-xs text-slate-500">No PO selected</p>
                </div>
              ) : activeRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center space-y-2 select-none">
                  <Inbox className="h-7 w-7 text-indigo-500/30 animate-pulse" />
                  <p className="text-xs text-slate-400">Awaiting first scan</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse min-w-[480px]">
                    <thead>
                      <tr className="border-b border-slate-800 text-[10px] uppercase font-bold text-slate-500 select-none">
                        <th className="py-2 px-3">SKU</th>
                        <th className="py-2 px-3 text-right">Ordered</th>
                        <th className="py-2 px-3 text-right">Pending</th>
                        <th className="py-2 px-3 text-right">Received</th>
                        <th className="py-2 px-3 text-center">Status</th>
                        <th className="py-2 px-3 text-right">Excess</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50 text-xs">
                      {activeRows.map(line => {
                        const received   = countingQty[line.sku] || 0;
                        const pendingQty = Math.max(0, line.original_quantity - received);
                        const excessQty  = Math.max(0, received - line.original_quantity);
                        return (
                          <tr key={line.sku} className="hover:bg-slate-800/30 transition">
                            <td className="py-2 px-3 font-mono font-bold text-indigo-300">{line.sku}</td>
                            <td className="py-2 px-3 text-right font-mono text-slate-400">{line.original_quantity}</td>
                            <td className="py-2 px-3 text-right font-mono text-slate-400">{pendingQty}</td>
                            <td className="py-2 px-3 text-right font-mono font-bold text-white">{received}</td>
                            <td className="py-2 px-3 text-center">
                              {received >= line.original_quantity ? (
                                <span className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-2 py-0.5 rounded text-[9px] font-bold uppercase">
                                  {excessQty > 0 ? 'Excess' : 'Done'}
                                </span>
                              ) : (
                                <span className="bg-amber-500/10 border border-amber-500/30 text-amber-300 px-2 py-0.5 rounded text-[9px] font-bold uppercase">
                                  Pending
                                </span>
                              )}
                            </td>
                            <td className={`py-2 px-3 text-right font-mono font-bold ${excessQty > 0 ? 'text-amber-300' : 'text-slate-700'}`}>
                              {excessQty > 0 ? `+${excessQty}` : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Live Scan Tape */}
            <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
              <h2 className="text-xs font-bold text-slate-100 uppercase tracking-wider flex items-center gap-2 border-b border-slate-800 pb-2 mb-3 select-none">
                <Terminal className="h-3.5 w-3.5 text-purple-400" />
                Live Scan Tape
              </h2>

              {scanTape.length === 0 && noProductData.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-10 text-slate-500 text-[11px] space-y-2 select-none">
                  <Terminal className="h-5 w-5 text-slate-700" />
                  <span>Awaiting first scan.</span>
                </div>
              ) : (
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-0.5">
                  {scanTape.map((log, i) => (
                    <div key={i} className={`p-2.5 rounded-xl border text-[10.5px] leading-snug space-y-0.5 ${
                      log.isExcess ? 'bg-amber-500/5 border-amber-500/20' : 'bg-slate-950 border-slate-800'
                    }`}>
                      <div className="flex justify-between items-center">
                        <span className="font-mono text-[10px] text-slate-500">{log.timestamp}</span>
                        <span className={`font-bold uppercase tracking-wider text-[9px] ${log.isExcess ? 'text-amber-400' : 'text-emerald-400'}`}>
                          {log.isExcess ? 'Excess' : 'OK'}
                        </span>
                      </div>
                      <div className="font-bold font-mono text-indigo-300">{log.sku}</div>
                      <p className="truncate text-slate-200">{log.name}</p>
                    </div>
                  ))}
                  {noProductData.map((log, i) => (
                    <div key={`miss-${i}`} className="p-2.5 rounded-xl border border-red-500/20 bg-red-500/5 text-[10.5px] leading-snug space-y-0.5">
                      <div className="flex justify-between items-center">
                        <span className="font-mono text-[10px] text-slate-500">{log.timestamp}</span>
                        <span className="font-bold text-red-400 uppercase tracking-wider text-[9px]">Error</span>
                      </div>
                      <div className="font-bold font-mono text-red-400">"{log.value}"</div>
                      <p className="text-red-300">{log.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>

          {/* End Session */}
          <div className="flex justify-end">
            <button
              onClick={() => {
                if (window.confirm('Finished scanning? This will lock the session and show the excess summary.')) {
                  setLocked(true);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }
              }}
              disabled={!activePoRefNum || poLines.length === 0}
              className="bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold uppercase tracking-wider py-2.5 px-6 rounded-xl flex items-center gap-2 shadow-lg cursor-pointer select-none"
            >
              <Lock className="h-3.5 w-3.5" />
              End Session
            </button>
          </div>

        </div>
      ) : (
        /* ── Locked / Summary Screen ── */
        <div className="space-y-6">

          {/* Locked Header */}
          <div className="bg-red-900/10 border border-red-500/30 p-6 rounded-2xl flex flex-col sm:flex-row items-center gap-5 shadow-inner">
            <div className="bg-red-600 text-white p-4 rounded-full shadow-lg shadow-red-500/20 shrink-0">
              <Lock className="h-7 w-7" />
            </div>
            <div className="space-y-1 text-center sm:text-left flex-grow">
              <h2 className="text-lg font-bold text-white">Session Locked — {activePoRefNum}</h2>
              <p className="text-xs text-red-300 max-w-2xl">
                Scanning is closed. Review excess quantities below, export the WMS report, or begin a new session.
              </p>
            </div>
            <button
              onClick={() => { resetSession(); }}
              className="bg-slate-900 border border-slate-800 text-slate-300 hover:text-white px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <Unlock className="h-4 w-4" />
              Begin New Session
            </button>
          </div>

          {/* Excess Quantity Summary */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-widest flex items-center gap-2 select-none">
                <Sparkles className="h-4 w-4 text-amber-400" />
                Excess Quantity Summary
              </h3>
              <p className="text-[11px] text-slate-500 mt-1">
                Items received beyond ordered quantity, or scanned items not in this PO. Labels were already printed automatically on each scan.
              </p>
            </div>

            {allExcessEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-slate-500 space-y-2 select-none">
                <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                <span className="text-xs font-bold text-slate-300">No Excess — Perfect Reconciliation</span>
                <p className="text-[10px]">Every scanned item matched the PO quantity exactly.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-[10.5px] uppercase font-bold text-slate-400 select-none">
                      <th className="py-2.5 px-3">SKU</th>
                      <th className="py-2.5 px-3 text-right">Excess Qty</th>
                      <th className="py-2.5 px-3">Product Name</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-xs">
                    {allExcessEntries.map(({ sku, excessQty, productName }) => (
                      <tr key={sku} className="hover:bg-slate-800/20 transition">
                        <td className="py-2.5 px-3 font-mono font-bold text-indigo-400">{sku}</td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="bg-amber-500/10 border border-amber-400/20 text-amber-400 font-bold font-mono px-2 py-0.5 rounded">
                            +{excessQty}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-slate-300 truncate max-w-[300px]">{productName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* No Product Data Panel */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4 opacity-75">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2 select-none">
                <ShieldAlert className="h-4 w-4 text-slate-500" />
                Unresolved Scans (No Product Data)
              </h3>
              <p className="text-[11px] text-slate-500 mt-1">
                Scanned codes that could not be matched in EasyEcomProductMaster.
              </p>
            </div>

            {noProductData.length === 0 ? (
              <p className="text-center py-6 text-slate-500 text-xs italic select-none">No unresolved scans this session.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-[10.5px] uppercase font-bold text-slate-500 select-none">
                        <th className="py-2.5 px-3">Scanned Value</th>
                        <th className="py-2.5 px-3">Time</th>
                        <th className="py-2.5 px-3">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-slate-400">
                      {noProductData.map((entry, i) => (
                        <tr key={i} className="hover:bg-slate-900/40">
                          <td className="py-2.5 px-3 font-mono text-red-400 font-bold">{entry.value}</td>
                          <td className="py-2.5 px-3 font-mono text-slate-500">{entry.timestamp}</td>
                          <td className="py-2.5 px-3">
                            <span className="text-[10px] font-bold bg-slate-950 border border-slate-800 text-slate-500 px-2 py-0.5 rounded uppercase">
                              {entry.reason}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-end pt-2">
                  <button
                    disabled
                    className="text-[10.5px] font-bold text-slate-600 border border-slate-800 px-4 py-2 rounded-lg cursor-not-allowed select-none"
                    title="Report export — placeholder"
                  >
                    Report (Coming Soon)
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Action Bar */}
          <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3 select-none">
              <ClipboardCheck className="h-5 w-5 text-indigo-400" />
              <span className="text-xs text-slate-400 font-medium">Export the WMS report or start a new session.</span>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
              <button
                onClick={handleExportWMSReport}
                className="bg-slate-950 border border-slate-800 hover:bg-slate-900 text-slate-300 text-[10.5px] font-bold uppercase tracking-wider py-3 px-6 rounded-xl transition cursor-pointer select-none text-center"
              >
                Export WMS Report
              </button>
              <button
                onClick={() => resetSession()}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-[10.5px] font-bold uppercase tracking-wider py-3 px-6 rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer select-none"
              >
                <Unlock className="h-3.5 w-3.5" />
                Begin New Session
              </button>
            </div>
          </div>

        </div>
      )}

      {/* ── Browser print portal ── */}
      {activePrintBatch.length > 0 && typeof document !== 'undefined' && createPortal(
        <div id="print-only-area" style={{ backgroundColor: '#ffffff' }}>
          {activePrintBatch.map((job, i) => (
            <div key={i} className="print-label-item">
              <BarcodePreview product={job.product} scale={1.0} batchNo={generateShipmentBatchNo()} />
            </div>
          ))}
        </div>,
        document.body
      )}

    </div>
  );
}
