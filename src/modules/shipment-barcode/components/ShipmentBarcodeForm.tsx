import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  RefreshCw, Terminal, AlertTriangle, CheckCircle2, XCircle,
  ShieldAlert, Inbox, FileSpreadsheet, Lock, Unlock,
  ClipboardCheck, Sparkles, Search, ChevronDown, ChevronRight,
  Plane, Ship, ArrowLeft,
} from 'lucide-react';
import { Product } from '../../../shared/types';
import { BarcodePreview } from '../../single-barcode-generator/components/BarcodePreview';
import { generateShipmentBatchNo } from '../../../shared/utilities/batchNo';
import { DuplicateEANModal } from '../../../shared/components/DuplicateEANModal';
import {
  isEANUPCSelected,
  checkEANDuplicate,
  recordSessionDuplicate,
  hasSessionDuplicates,
  sendSessionDuplicateEmail,
} from '../../../shared/services/EANDuplicateService';

// ── Types ────────────────────────────────────────────────────────────────────

interface ShipmentSummary {
  vendor_code: string;
  shipment_id: string;
  carton_count: number;
  invoice_no: string;
  invoice_date: string;
  total_units: number;
}

interface Batch {
  batch_id: string;
  batch_type: 'air' | 'sea';
  status: string;
  total_shipments: number;
  total_cartons: number;
  total_units: number;
  expected_delivery: string | null;
  actual_delivery: string | null;
  carrier: string;
  is_delayed: boolean;
  delay_days: number;
  vendor_summary: ShipmentSummary[];
}

interface LineItem {
  sku: string;
  item_name: string;
  ean: string;
  incoming_qty: number;
}

interface VendorShipment {
  shipment_id: string;
  vendor_code: string;
  vendor_name: string;
  invoice_no: string;
  total_units: number;
  carton_count: number;
  line_items: LineItem[];
}

interface BatchDetail {
  batch_id: string;
  batch_type: string;
  status: string;
  vendor_shipments: VendorShipment[];
}

interface ShipmentLine {
  sku: string;
  item_name: string;
  original_quantity: number;
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

type ScanStatusState = {
  type: 'idle' | 'success' | 'warning' | 'error' | 'processing';
  message: string;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function ShipmentBarcodeForm() {

  // ── Batch browse state ───────────────────────────────────────────────────
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [batchesError, setBatchesError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'air' | 'sea'>('all');
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [batchDetails, setBatchDetails] = useState<Record<string, BatchDetail>>({});
  const [batchDetailLoading, setBatchDetailLoading] = useState<string | null>(null);
  const [expandedShipmentId, setExpandedShipmentId] = useState<string | null>(null);

  // ── View / active shipment state ─────────────────────────────────────────
  const [view, setView] = useState<'browse' | 'scanning'>('browse');
  const [activeShipmentId, setActiveShipmentId] = useState<string | null>(null);
  const [activeShipmentLines, setActiveShipmentLines] = useState<ShipmentLine[]>([]);

  // ── Session scanning state ───────────────────────────────────────────────
  const [countingQty, setCountingQty]           = useState<Record<string, number>>({});
  const [productCache, setProductCache]         = useState<Record<string, Product>>({});
  const [excessQtyFrequency, setExcessQtyFrequency] = useState<Record<string, number>>({});
  const [noProductData, setNoProductData]       = useState<NoProductEntry[]>([]);
  const [scanTape, setScanTape]                 = useState<ScanTapeEntry[]>([]);
  const [activePrintBatch, setActivePrintBatch] = useState<Array<{ product: Product }>>([]);
  const [locked, setLocked]                     = useState(false);

  // ── Duplicate EAN state ──────────────────────────────────────────────────
  const [duplicateModal, setDuplicateModal] = useState<{ ean: string; products: Product[] } | null>(null);
  const [sessionHasDuplicates, setSessionHasDuplicates] = useState<boolean>(() => hasSessionDuplicates());

  // ── Scanner input ────────────────────────────────────────────────────────
  const [scanMode, setScanMode] = useState<'autofocus' | 'manual'>(() => {
    const v = localStorage.getItem('shipment_scan_mode');
    return v === 'autofocus' || v === 'manual' ? v : 'autofocus';
  });
  const [barcodeInput, setBarcodeInput] = useState('');
  const [scanStatus, setScanStatus]     = useState<ScanStatusState>({
    type: 'idle',
    message: 'Select a shipment to begin scanning.',
  });

  const inputRef           = useRef<HTMLInputElement>(null);
  const autoScanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load batches on mount ─────────────────────────────────────────────────

  useEffect(() => { loadBatches(); }, []);

  // ── scanMode persistence ──────────────────────────────────────────────────

  useEffect(() => {
    localStorage.setItem('shipment_scan_mode', scanMode);
  }, [scanMode]);

  // ── Auto-focus loop (only in scanning view) ───────────────────────────────

  useEffect(() => {
    if (locked || view !== 'scanning' || scanMode !== 'autofocus' || !activeShipmentId) return;
    const interval = setInterval(() => {
      if (document.activeElement !== inputRef.current && inputRef.current) {
        inputRef.current.focus();
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [locked, view, scanMode, activeShipmentId]);

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

  // ── Global keydown for manual mode ───────────────────────────────────────

  useEffect(() => {
    if (locked || view !== 'scanning' || scanMode !== 'manual' || !activeShipmentId) return;
    let buffer = '';
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
        if (el !== inputRef.current) return;
      }
      if (['Tab','Escape','Shift','Control','Alt','Meta','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End'].includes(e.key)) return;
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
  }, [locked, view, scanMode, activeShipmentId, activeShipmentLines, excessQtyFrequency]);

  // ── Auto-print when activePrintBatch is populated ─────────────────────────

  useEffect(() => {
    if (!activePrintBatch.length) return;
    const timer = setTimeout(() => {
      window.print();
      setTimeout(() => setActivePrintBatch([]), 800);
    }, 500);
    return () => clearTimeout(timer);
  }, [activePrintBatch]);

  // ── Search: auto-expand when query matches a shipment_id ──────────────────

  useEffect(() => {
    if (!searchQuery) return;
    const q = searchQuery.toLowerCase().trim();
    const batchMatch = batches.find(b => b.batch_id.toLowerCase().includes(q));
    if (!batchMatch) {
      const viaShipment = batches.find(b =>
        (b.vendor_summary || []).some(s => s.shipment_id.toLowerCase().includes(q))
      );
      if (viaShipment) {
        loadBatchDetail(viaShipment.batch_id);
        const matchingSummary = (viaShipment.vendor_summary || []).find(s =>
          s.shipment_id.toLowerCase().includes(q)
        );
        if (matchingSummary) setExpandedShipmentId(matchingSummary.shipment_id);
      }
    }
  }, [searchQuery]);

  // ── Data loaders ─────────────────────────────────────────────────────────

  const loadBatches = async () => {
    setBatchesLoading(true);
    setBatchesError(null);
    try {
      const res = await fetch('/api/shipment/batches');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: Batch[] = Array.isArray(data) ? data : (data.batches || []);
      setBatches(list);
    } catch (err: any) {
      setBatchesError(err.message || 'Failed to load batches.');
    } finally {
      setBatchesLoading(false);
    }
  };

  const loadBatchDetail = async (batchId: string) => {
    if (batchDetails[batchId]) {
      setExpandedBatchId(prev => (prev === batchId ? null : batchId));
      return;
    }
    setBatchDetailLoading(batchId);
    try {
      const res = await fetch(`/api/shipment/batch-detail?batch_id=${encodeURIComponent(batchId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const detail: BatchDetail = data.batch || data;
      setBatchDetails(prev => ({ ...prev, [batchId]: detail }));
      setExpandedBatchId(batchId);
    } catch {
      // Fallback: expand without line items
      setExpandedBatchId(prev => (prev === batchId ? null : batchId));
    } finally {
      setBatchDetailLoading(null);
    }
  };

  const handleBatchClick = (batchId: string) => {
    if (expandedBatchId === batchId) {
      setExpandedBatchId(null);
      setExpandedShipmentId(null);
    } else {
      loadBatchDetail(batchId);
      setExpandedShipmentId(null);
    }
  };

  // ── Session management ────────────────────────────────────────────────────

  const resetSession = () => {
    setCountingQty({});
    setExcessQtyFrequency({});
    setNoProductData([]);
    setScanTape([]);
    setActivePrintBatch([]);
    setLocked(false);
    setScanStatus({ type: 'idle', message: `Shipment "${activeShipmentId}" loaded. Ready to scan.` });
  };

  const startScanning = (shipment: VendorShipment) => {
    const lines: ShipmentLine[] = (shipment.line_items || []).map(l => ({
      sku: l.sku,
      item_name: l.item_name,
      original_quantity: l.incoming_qty,
    }));
    setActiveShipmentId(shipment.shipment_id);
    setActiveShipmentLines(lines);
    setCountingQty({});
    setExcessQtyFrequency({});
    setNoProductData([]);
    setScanTape([]);
    setActivePrintBatch([]);
    setLocked(false);
    setView('scanning');
    setScanStatus({
      type: 'idle',
      message: `Shipment "${shipment.shipment_id}" loaded — ${lines.length} SKU${lines.length !== 1 ? 's' : ''}. Ready to scan.`,
    });
  };

  const backToBrowse = () => {
    setView('browse');
    setLocked(false);
  };

  // ── Core scan engine ──────────────────────────────────────────────────────

  const executeBarcodeScan = async (cleanValue: string) => {
    if (!cleanValue || !activeShipmentId) return;
    setScanStatus({ type: 'processing', message: `Querying: "${cleanValue}"` });

    try {
      const res = await fetch('/api/barcode/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: cleanValue }),
      });

      if (res.status === 404) {
        const inShipment = activeShipmentLines.some(l => l.sku.toLowerCase() === cleanValue.toLowerCase());
        const reason = inShipment ? 'Missing Product Master Data' : 'Unknown SKU';
        setNoProductData(prev => [{ value: cleanValue, timestamp: new Date().toLocaleTimeString(), reason }, ...prev]);
        setScanStatus({ type: 'error', message: `${reason}: "${cleanValue}" — cannot print label.` });
        return;
      }
      if (!res.ok) throw new Error(`Server error HTTP ${res.status}`);

      const product: Product = await res.json();
      setProductCache(prev => ({ ...prev, [product.sku]: product }));

      // Duplicate EAN check
      if (isEANUPCSelected(product.EANUPC)) {
        try {
          const { isDuplicate, products: dupeProducts } = await checkEANDuplicate(product.EANUPC!.trim(), product.sku);
          if (isDuplicate) {
            recordSessionDuplicate({
              ean: product.EANUPC!.trim(),
              affectedProducts: dupeProducts.map(p => ({ sku: p.sku, productName: p.product_name })),
              timestamp: new Date().toISOString(),
              module: 'Shipment Barcode',
            });
            setSessionHasDuplicates(true);
            setDuplicateModal({ ean: product.EANUPC!.trim(), products: dupeProducts });
            setScanStatus({
              type: 'error',
              message: `BLOCKED: Duplicate EAN [${product.EANUPC!.trim()}] on SKU "${product.sku}". Printing blocked.`,
            });
            sendSessionDuplicateEmail('Shipment Barcode').catch(e =>
              console.error('[EAN Duplicate] Auto-email failed:', e)
            );
            return;
          }
        } catch (err) {
          console.error('[EAN Duplicate Check] Failed:', err);
          setScanStatus({
            type: 'error',
            message: 'EAN duplicate check failed — scan blocked for safety. Check server connection.',
          });
          return; // Block on error
        }
      }

      const shipmentLine = activeShipmentLines.find(l => l.sku.toLowerCase() === product.sku.toLowerCase());

      if (shipmentLine) {
        const nextCount = (countingQty[product.sku] || 0) + 1;
        setCountingQty(prev => ({ ...prev, [product.sku]: nextCount }));
        const isExcess = nextCount > shipmentLine.original_quantity;
        if (isExcess) {
          setExcessQtyFrequency(prev => ({ ...prev, [product.sku]: nextCount - shipmentLine.original_quantity }));
        }
        setScanTape(prev => [{ sku: product.sku, name: product.product_name, timestamp: new Date().toLocaleTimeString(), isExcess }, ...prev]);
        setActivePrintBatch([{ product }]);
        setScanStatus({
          type: isExcess ? 'warning' : 'success',
          message: isExcess
            ? `EXCESS: [${product.sku}] ${product.product_name} — received ${nextCount}, expected ${shipmentLine.original_quantity}. Label printed.`
            : `RECEIVED: [${product.sku}] ${product.product_name}. Label sent to printer.`,
        });
      } else {
        const nextExcess = (excessQtyFrequency[product.sku] || 0) + 1;
        setExcessQtyFrequency(prev => ({ ...prev, [product.sku]: nextExcess }));
        setScanTape(prev => [{ sku: product.sku, name: product.product_name, timestamp: new Date().toLocaleTimeString(), isExcess: true }, ...prev]);
        setActivePrintBatch([{ product }]);
        setScanStatus({
          type: 'warning',
          message: `UNEXPECTED: [${product.sku}] ${product.product_name} not in active shipment. Treating as excess — label printed.`,
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

  // ── WMS Report export ─────────────────────────────────────────────────────

  const handleExportWMSReport = () => {
    const rows: string[][] = [['Section', 'SKU', 'Product Name', 'Expected Qty', 'Received Qty', 'Excess Qty', 'Notes']];

    for (const line of activeShipmentLines) {
      const received = countingQty[line.sku] || 0;
      const excess   = Math.max(0, received - line.original_quantity);
      if (received > 0 || excess > 0) {
        const name = productCache[line.sku]?.product_name || line.item_name || '';
        rows.push(['SHIPMENT LINE', line.sku, `"${name.replace(/"/g, '""')}"`,
          line.original_quantity.toString(), received.toString(), excess.toString(), '']);
      }
    }

    for (const sku of Object.keys(excessQtyFrequency)) {
      if (activeShipmentLines.some(l => l.sku.toLowerCase() === sku.toLowerCase())) continue;
      const name = productCache[sku]?.product_name || 'Unexpected SKU';
      rows.push(['UNEXPECTED', sku, `"${name.replace(/"/g, '""')}"`,
        '0', '0', excessQtyFrequency[sku].toString(), 'Not in active shipment']);
    }

    for (const entry of noProductData) {
      rows.push(['NO PRODUCT DATA', `"${entry.value.replace(/"/g, '""')}"`, '"—"',
        '0', '0', '0', `"${entry.reason} @ ${entry.timestamp}"`]);
    }

    const csv = 'data:text/csv;charset=utf-8,' + rows.map(r => r.join(',')).join('\n');
    const a   = document.createElement('a');
    a.href     = encodeURI(csv);
    a.download = `WMS_Report_${activeShipmentId || 'SHIPMENT'}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const filteredBatches = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return batches.filter(b => {
      const typeMatch = typeFilter === 'all' || b.batch_type === typeFilter;
      if (!q) return typeMatch;
      const batchMatch    = b.batch_id.toLowerCase().includes(q);
      const shipmentMatch = (b.vendor_summary || []).some(s => s.shipment_id.toLowerCase().includes(q));
      return typeMatch && (batchMatch || shipmentMatch);
    });
  }, [batches, searchQuery, typeFilter]);

  const activeRows = activeShipmentLines.filter(l => (countingQty[l.sku] || 0) > 0);
  const linesCompleted = activeShipmentLines.filter(l => (countingQty[l.sku] || 0) >= l.original_quantity).length;
  const allExcessEntries = Object.keys(excessQtyFrequency).map(sku => ({
    sku,
    excessQty:   excessQtyFrequency[sku],
    productName: productCache[sku]?.product_name || (activeShipmentLines.find(l => l.sku === sku)?.item_name || sku),
  }));

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-2.5">

      {/* ── Header Bar ── */}
      <div className="flex items-center justify-between bg-slate-900 border border-slate-800 px-4 py-2.5 rounded-xl gap-4">
        <div className="flex items-center gap-3 min-w-0">
          {view === 'scanning' && (
            <button
              onClick={backToBrowse}
              className="flex items-center gap-1 text-slate-400 hover:text-white text-[10px] font-bold shrink-0 cursor-pointer transition"
            >
              <ArrowLeft className="h-3 w-3" />
              Batches
            </button>
          )}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[9px] uppercase bg-amber-500/10 border border-amber-500/30 text-amber-400 px-2 py-0.5 rounded font-bold tracking-wider">Inbound</span>
            {view === 'scanning' && activeShipmentId && (
              <span className="text-[9px] uppercase bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 px-2 py-0.5 rounded font-bold tracking-wider font-mono">
                {activeShipmentId}
              </span>
            )}
          </div>
          <h1 className="text-sm font-bold tracking-tight text-white whitespace-nowrap">Shipment Barcode Receiving</h1>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {view === 'browse' && (
            <button
              onClick={loadBatches}
              disabled={batchesLoading}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[11px] font-semibold py-1.5 px-3 rounded-lg transition cursor-pointer select-none whitespace-nowrap"
            >
              <RefreshCw className={`h-3 w-3 ${batchesLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          )}
          {view === 'scanning' && !locked && (
            <span className="text-[10px] text-slate-500">{linesCompleted}/{activeShipmentLines.length} lines done</span>
          )}
        </div>
      </div>

      {/* ── Browse View ── */}
      {view === 'browse' && (
        <>
          {/* Search + type filter */}
          <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-3.5 w-3.5 text-slate-500" />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search by batch ID or shipment ID…"
                className="w-full bg-slate-950 border border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 font-mono transition"
              />
            </div>
            <div className="inline-flex rounded-lg bg-slate-800 p-0.5 shrink-0">
              {(['all', 'air', 'sea'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setTypeFilter(f)}
                  className={`px-3 py-1 text-[10px] font-bold rounded-md transition cursor-pointer flex items-center gap-1 ${
                    typeFilter === f ? 'bg-slate-600 text-white shadow' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {f === 'air' && <Plane className="h-2.5 w-2.5" />}
                  {f === 'sea' && <Ship className="h-2.5 w-2.5" />}
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Batch list */}
          <div className="space-y-2">
            {batchesLoading && (
              <div className="flex items-center justify-center py-12 text-indigo-400 gap-2 text-xs">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading batches…
              </div>
            )}

            {batchesError && (
              <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-xs text-red-300">
                <XCircle className="h-4 w-4 shrink-0" />
                {batchesError}
              </div>
            )}

            {!batchesLoading && !batchesError && filteredBatches.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center space-y-2">
                <Inbox className="h-7 w-7 text-slate-700" />
                <p className="text-xs text-slate-500">{batches.length === 0 ? 'No batches loaded. Click Refresh.' : 'No batches match your search.'}</p>
              </div>
            )}

            {filteredBatches.map(batch => {
              const isExpanded    = expandedBatchId === batch.batch_id;
              const isLoadingThis = batchDetailLoading === batch.batch_id;
              const detail        = batchDetails[batch.batch_id];
              const q             = searchQuery.toLowerCase().trim();

              return (
                <div key={batch.batch_id} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">

                  {/* Batch row */}
                  <button
                    onClick={() => handleBatchClick(batch.batch_id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 transition cursor-pointer text-left"
                  >
                    <span className="text-slate-500 shrink-0">
                      {isLoadingThis
                        ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                        : isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5" />
                          : <ChevronRight className="h-3.5 w-3.5" />
                      }
                    </span>

                    {/* Type badge */}
                    <span className={`shrink-0 flex items-center gap-1 text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${
                      batch.batch_type === 'air'
                        ? 'bg-sky-500/10 border-sky-500/30 text-sky-400'
                        : 'bg-teal-500/10 border-teal-500/30 text-teal-400'
                    }`}>
                      {batch.batch_type === 'air' ? <Plane className="h-2.5 w-2.5" /> : <Ship className="h-2.5 w-2.5" />}
                      {batch.batch_type?.toUpperCase()}
                    </span>

                    <span className="font-mono font-bold text-sm text-white">{batch.batch_id}</span>

                    {/* Status badge */}
                    <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${
                      batch.status?.toLowerCase() === 'open'
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : batch.status?.toLowerCase() === 'shipped'
                          ? 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                          : 'bg-slate-700/50 border-slate-700 text-slate-500'
                    }`}>
                      {batch.status || '—'}
                    </span>

                    {batch.is_delayed && (
                      <span className="text-[9px] font-bold bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-0.5 rounded uppercase">
                        Delayed {batch.delay_days}d
                      </span>
                    )}

                    <div className="flex-1" />

                    <div className="flex items-center gap-4 text-[10px] text-slate-500 shrink-0">
                      <span>{batch.total_shipments ?? (batch.vendor_summary?.length ?? 0)} shipments</span>
                      <span>{(batch.total_units ?? 0).toLocaleString()} units</span>
                      {batch.expected_delivery && (
                        <span>ETA {new Date(batch.expected_delivery).toLocaleDateString()}</span>
                      )}
                    </div>
                  </button>

                  {/* Expanded: shipments list */}
                  {isExpanded && (
                    <div className="border-t border-slate-800 bg-slate-950/40">
                      {/* Use detail.vendor_shipments if loaded, else fall back to vendor_summary */}
                      {detail?.vendor_shipments?.length
                        ? detail.vendor_shipments.map(shipment => {
                            const shipIsExpanded = expandedShipmentId === shipment.shipment_id;
                            const isHighlighted  = q && shipment.shipment_id.toLowerCase().includes(q);

                            return (
                              <div
                                key={shipment.shipment_id}
                                className={`border-b border-slate-800/60 last:border-0 ${isHighlighted ? 'ring-1 ring-inset ring-indigo-500/30' : ''}`}
                              >
                                {/* Shipment row */}
                                <button
                                  onClick={() => setExpandedShipmentId(prev => prev === shipment.shipment_id ? null : shipment.shipment_id)}
                                  className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-slate-800/30 transition cursor-pointer text-left"
                                >
                                  <span className="text-slate-600 shrink-0">
                                    {shipIsExpanded
                                      ? <ChevronDown className="h-3 w-3" />
                                      : <ChevronRight className="h-3 w-3" />
                                    }
                                  </span>
                                  <span className="font-mono font-bold text-xs text-indigo-300">{shipment.shipment_id}</span>
                                  <span className="text-[10px] text-slate-500 font-mono">{shipment.vendor_code}</span>
                                  {shipment.invoice_no && (
                                    <span className="text-[10px] text-slate-600">Invoice: {shipment.invoice_no}</span>
                                  )}
                                  <div className="flex-1" />
                                  <span className="text-[10px] text-slate-500">
                                    {shipment.carton_count} ctn · {(shipment.total_units ?? 0).toLocaleString()} units
                                  </span>
                                </button>

                                {/* Expanded: SKU list */}
                                {shipIsExpanded && (
                                  <div className="px-5 pb-4">
                                    {!shipment.line_items?.length ? (
                                      <p className="text-xs text-slate-600 py-3 italic">No line items found.</p>
                                    ) : (
                                      <>
                                        <div className="overflow-x-auto mb-3">
                                          <table className="w-full text-left border-collapse min-w-[400px]">
                                            <thead>
                                              <tr className="border-b border-slate-800 text-[9px] uppercase font-bold text-slate-600">
                                                <th className="py-1.5 px-2">SKU</th>
                                                <th className="py-1.5 px-2">Item Name</th>
                                                <th className="py-1.5 px-2">EAN</th>
                                                <th className="py-1.5 px-2 text-right">Qty</th>
                                              </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-800/40 text-[10.5px]">
                                              {shipment.line_items.map((li, idx) => (
                                                <tr key={idx} className="hover:bg-slate-800/20">
                                                  <td className="py-1.5 px-2 font-mono font-bold text-indigo-400">{li.sku}</td>
                                                  <td className="py-1.5 px-2 text-slate-300 max-w-[200px] truncate">{li.item_name}</td>
                                                  <td className="py-1.5 px-2 font-mono text-slate-500">{li.ean || '—'}</td>
                                                  <td className="py-1.5 px-2 text-right font-mono font-bold text-white">{li.incoming_qty}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                        <div className="flex justify-end">
                                          <button
                                            onClick={() => startScanning(shipment)}
                                            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold uppercase tracking-wider py-2 px-5 rounded-xl transition cursor-pointer select-none"
                                          >
                                            <Terminal className="h-3.5 w-3.5" />
                                            Start Scanning This Shipment
                                          </button>
                                        </div>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        : /* Fallback: show vendor_summary rows without line items */
                          (batch.vendor_summary || []).map(summary => {
                            const isHighlighted = q && summary.shipment_id.toLowerCase().includes(q);
                            return (
                              <div
                                key={summary.shipment_id}
                                className={`border-b border-slate-800/60 last:border-0 px-5 py-2.5 flex items-center gap-3 ${isHighlighted ? 'ring-1 ring-inset ring-indigo-500/30' : ''}`}
                              >
                                <span className="font-mono text-xs text-indigo-300">{summary.shipment_id}</span>
                                <span className="text-[10px] text-slate-500">{summary.vendor_code}</span>
                                {summary.invoice_no && <span className="text-[10px] text-slate-600">Invoice: {summary.invoice_no}</span>}
                                <div className="flex-1" />
                                <span className="text-[10px] text-slate-500">{summary.carton_count} ctn · {summary.total_units} units</span>
                                <span className="text-[10px] text-slate-600 italic">(expand batch to load lines)</span>
                              </div>
                            );
                          })
                      }
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Scanning View ── */}
      {view === 'scanning' && !locked && (
        <div className="flex flex-col gap-2.5">

          {/* Scan Input */}
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
                placeholder={
                  scanMode === 'autofocus'
                    ? '🎯 AUTO-FOCUS ACTIVE — SCAN BARCODES DIRECTLY...'
                    : '✏️ TYPE SKU OR SCAN ANYWHERE — PRESS ENTER TO SUBMIT...'
                }
                className="w-full bg-indigo-900 border-2 border-indigo-400/40 focus:border-white rounded-xl px-4 py-3.5 text-sm font-mono tracking-widest text-white placeholder:text-indigo-300/60 focus:outline-none focus:ring-2 focus:ring-white/20 transition text-center uppercase caret-white"
              />
              {scanMode === 'manual' && (
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
              {scanStatus.type === 'error'      && <XCircle      className="h-3.5 w-3.5 shrink-0" />}
              {scanStatus.type === 'success'    && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
              {scanStatus.type === 'warning'    && <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
              {scanStatus.type === 'processing' && <RefreshCw    className="h-3.5 w-3.5 shrink-0 animate-spin" />}
              {scanStatus.type === 'idle'       && <Terminal     className="h-3.5 w-3.5 shrink-0 text-indigo-300" />}
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
                {activeShipmentLines.length > 0 && (
                  <span className="text-[10px] font-bold text-slate-400">
                    {activeRows.length} / {activeShipmentLines.length} scanned
                  </span>
                )}
              </div>

              {activeRows.length === 0 ? (
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
          <div className="flex justify-end items-center gap-3">
            {sessionHasDuplicates && (
              <span className="text-[10px] text-amber-400 font-semibold">
                Duplicate EANs queued — email will send on End Session
              </span>
            )}
            <button
              onClick={async () => {
                if (window.confirm('Finished scanning? This will lock the session and show the excess summary.')) {
                  if (sessionHasDuplicates) {
                    await sendSessionDuplicateEmail('Shipment Barcode');
                  }
                  setLocked(true);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }
              }}
              className="bg-red-700 hover:bg-red-600 text-white text-xs font-bold uppercase tracking-wider py-2.5 px-6 rounded-xl flex items-center gap-2 shadow-lg cursor-pointer select-none"
            >
              <Lock className="h-3.5 w-3.5" />
              End Session
            </button>
          </div>
        </div>
      )}

      {/* ── Locked / Summary Screen ── */}
      {view === 'scanning' && locked && (
        <div className="space-y-6">

          {/* Locked Header */}
          <div className="bg-red-900/10 border border-red-500/30 p-6 rounded-2xl flex flex-col sm:flex-row items-center gap-5 shadow-inner">
            <div className="bg-red-600 text-white p-4 rounded-full shadow-lg shadow-red-500/20 shrink-0">
              <Lock className="h-7 w-7" />
            </div>
            <div className="space-y-1 text-center sm:text-left flex-grow">
              <h2 className="text-lg font-bold text-white">Session Locked — {activeShipmentId}</h2>
              <p className="text-xs text-red-300 max-w-2xl">
                Scanning is closed. Review excess quantities below, export the WMS report, or begin a new session.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 shrink-0">
              <button
                onClick={backToBrowse}
                className="bg-slate-900 border border-slate-800 text-slate-300 hover:text-white px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Select Shipment
              </button>
              <button
                onClick={resetSession}
                className="bg-slate-900 border border-slate-800 text-slate-300 hover:text-white px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer"
              >
                <Unlock className="h-4 w-4" />
                Begin New Session
              </button>
            </div>
          </div>

          {/* Excess Quantity Summary */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-widest flex items-center gap-2 select-none">
                <Sparkles className="h-4 w-4 text-amber-400" />
                Excess Quantity Summary
              </h3>
              <p className="text-[11px] text-slate-500 mt-1">
                Items received beyond ordered quantity, or scanned items not in this shipment. Labels were already printed automatically on each scan.
              </p>
            </div>

            {allExcessEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-slate-500 space-y-2 select-none">
                <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                <span className="text-xs font-bold text-slate-300">No Excess — Perfect Reconciliation</span>
                <p className="text-[10px]">Every scanned item matched the shipment quantity exactly.</p>
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
                onClick={resetSession}
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

      {/* ── Duplicate EAN blocking modal ── */}
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
