import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { 
  RefreshCw,
  Database,
  Terminal,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Printer,
  ShieldAlert,
  Inbox, 
  FileSpreadsheet, 
  Lock, 
  Unlock, 
  ClipboardCheck, 
  Copy, 
  Sparkles,
  BarChart4
} from 'lucide-react';
import { Product } from '../../../shared/types';
import { BarcodePreview } from '../../single-barcode-generator/components/BarcodePreview';
import { generateShipmentBatchNo } from '../../../shared/utilities/batchNo';
import { downloadLabelsPdf, generateLabelsPdfBlob } from '../../../shared/utilities/pdfExport';

const PDF_ENABLE = import.meta.env.VITE_PDF_ENABLE === 'true';
const SILENT_PRINT = import.meta.env.VITE_SILENT_PRINT === 'true';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

interface ShipmentItem {
  sku: string;
  product_id?: string;
  planned_mode: 'AIR' | 'SEA';
  sku_name: string;
  cu_ordered_qty: number;
  fulfilled_qty: number;
  session_qty?: number;
}

export function ShipmentBarcodeForm() {
  // Active shipment mode tab
  const [activeMode, setActiveMode] = useState<'AIR' | 'SEA'>('AIR');

  // Session locked/finished state
  const [locked, setLocked] = useState<boolean>(false);
  const [isConfirming, setIsConfirming] = useState<boolean>(false);

  const [showScriptModal, setShowScriptModal] = useState<boolean>(false);

  // Connection/Syncing states
  const [syncStatus, setSyncStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; message: string }>({
    type: 'idle',
    message: ''
  });

  // Database shipment list entries
  const [shipmentItems, setShipmentItems] = useState<ShipmentItem[]>([]);
  const [loadingItems, setLoadingItems] = useState<boolean>(false);

  // Frontend-only counting states
  const [countingQty, setCountingQty] = useState<{ [sku: string]: number }>({});

  // Scanned barcodes not matched in products
  const [noProductData, setNoProductData] = useState<Array<{ value: string; timestamp: string; reason: string }>>([]);

  // Excess quantities tracks unexpected SKU count or over-scanned count
  const [excessQtyFrequency, setExcessQtyFrequency] = useState<{ [sku: string]: number }>({});

  // Log of matching product scans to display a live tape
  const [scanTape, setScanTape] = useState<Array<{ sku: string; name: string; timestamp: string; isUnexpected: boolean }>>([]);

  // Print Queue of barcodes that have been triggered (live log of all items sent to thermal print engine)
  const [barcodePrintQueue, setBarcodePrintQueue] = useState<string[]>([]);

  // Active print batch: temporarily populated, triggers browser print, then cleared
  const [activePrintBatch, setActivePrintBatch] = useState<Array<{ product: Product }>>([]);

  // Ref to the off-screen container used by html2canvas for PDF capture
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  // Scanner input mode state: 'autofocus' (continuous) or 'manual' (regular input integrated with focus-free)
  const [scanMode, setScanMode] = useState<'autofocus' | 'manual'>(() => {
    const val = localStorage.getItem('shipment_scan_mode');
    return (val === 'autofocus' || val === 'manual') ? val : 'autofocus';
  });

  // Input states
  const [barcodeInput, setBarcodeInput] = useState<string>('');
  const [scanStatus, setScanStatus] = useState<{ type: 'idle' | 'success' | 'warning' | 'error' | 'processing'; message: string }>({
    type: 'idle',
    message: 'Continuous Auto-Focus mode active. Just scan barcodes physically with your laser scanner.'
  });

  // DOM Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const autoScanTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    localStorage.setItem('shipment_scan_mode', scanMode);
    if (scanMode === 'autofocus') {
      setScanStatus({
        type: 'idle',
        message: 'Continuous Auto-Focus mode active. Scanned SKUs are automatically processed and printed instantly.'
      });
    } else {
      setScanStatus({
        type: 'idle',
        message: 'Manual & Focus-Free mode active. Input characters manually or scan physically anywhere on-screen.'
      });
    }
  }, [scanMode]);

  const refreshShipmentListFromDB = async (mode: 'AIR' | 'SEA') => {
    setLoadingItems(true);
    try {
      const res = await fetch(`/api/shipment/list?mode=${mode}`);
      if (res.ok) {
        const data: ShipmentItem[] = await res.json();
        setShipmentItems(data);
        // Restore in-progress session counts from DB so a refresh doesn't lose them
        const restored: { [sku: string]: number } = {};
        for (const item of data) {
          if ((item.session_qty ?? 0) > 0) restored[item.sku] = item.session_qty!;
        }
        setCountingQty(prev => ({ ...prev, ...restored }));
      }
    } catch (err) {
      console.error('Failed to load shipment details:', err);
    } finally {
      setLoadingItems(false);
    }
  };

  // Reset all per-session state and reload shipment items whenever the active mode tab changes
  useEffect(() => {
    setLocked(false);
    setIsConfirming(false);
    setCountingQty({});
    setNoProductData([]);
    setExcessQtyFrequency({});
    setScanTape([]);
    setBarcodePrintQueue([]);
    setActivePrintBatch([]);
    setBarcodeInput('');
    setSyncStatus({ type: 'idle', message: '' });
    refreshShipmentListFromDB(activeMode);
  }, [activeMode]);

  // Continuous auto-focus logic to allow hands-free warehouse environments (only when scanMode is autofocus)
  useEffect(() => {
    if (locked || scanMode !== 'autofocus') return;

    const interval = setInterval(() => {
      if (document.activeElement !== inputRef.current && inputRef.current) {
        inputRef.current.focus();
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [locked, scanMode]);

  // Handle automatic printing when an active print batch is populated.
  // SILENT_PRINT=true: generates PDF and POSTs to /api/print/silent (no browser dialog).
  // SILENT_PRINT=false: downloads PDF if PDF_ENABLE, then calls window.print().
  //
  // IMPORTANT: setActivePrintBatch([]) is NOT in a finally block. For window.print() paths we
  // delay clearing so the portal DOM stays alive long enough for the browser to capture it for
  // the print preview. Clearing immediately (in finally) was causing blank print previews.
  useEffect(() => {
    if (activePrintBatch.length > 0) {
      const timer = setTimeout(async () => {
        const clearAfter = (ms: number) => setTimeout(() => setActivePrintBatch([]), ms);

        try {
          if (SILENT_PRINT && pdfContainerRef.current) {
            const blob = await generateLabelsPdfBlob(pdfContainerRef.current);
            const pdf_base64 = await blobToBase64(blob);
            const res = await fetch('/api/print/silent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pdf_base64 }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Silent print failed');
            setActivePrintBatch([]); // success: clear immediately, no dialog to feed
          } else {
            if (PDF_ENABLE && pdfContainerRef.current) {
              const date = new Date().toISOString().slice(0, 10);
              await downloadLabelsPdf(pdfContainerRef.current, `Shipment_Labels_${activeMode}_${date}.pdf`);
            }
            window.print();
            clearAfter(800); // keep portal in DOM until browser has captured it
          }
        } catch (err) {
          console.error('[Print] Silent print failed, falling back to window.print():', err);
          window.print();
          clearAfter(800); // same delay for fallback path
        }
      }, 500); // 500ms: gives JsBarcode's useEffect time to render SVG after mount

      return () => clearTimeout(timer);
    }
  }, [activePrintBatch, activeMode]);

  // Sync mechanism connecting with Apps Script (URL is read from server env, not frontend)
  const handleShipmentSync = async (useDemo: boolean = false) => {
    setSyncStatus({ type: 'loading', message: 'Syncing details. Please wait...' });
    try {
      const res = await fetch('/api/shipment/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demo: useDemo })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Server error during sync operations.');
      }

      const result = await res.json();
      setSyncStatus({ 
        type: 'success', 
        message: `Successfully synchronized ${result.count} cumulative shipment products!` 
      });
      
      // Auto refresh table UI
      await refreshShipmentListFromDB(activeMode);
      
      // Clear alert after some time
      setTimeout(() => {
        setSyncStatus({ type: 'idle', message: '' });
      }, 5000);

    } catch (err: any) {
      console.error(err);
      setSyncStatus({ 
        type: 'error', 
        message: err.message || 'Network failure connecting to remote synchronization proxy.' 
      });
    }
  };

  // Safe table reset — only wipes rows for the active mode
  const handleWipeDatabaseTable = async () => {
    if (!window.confirm(`Are you sure you want to reset the ${activeMode} shipment database cache? This will blank your '${activeMode}' ordered quotas.`)) {
      return;
    }

    setSyncStatus({ type: 'loading', message: 'Wiping database rows...' });
    try {
      const res = await fetch('/api/shipment/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planned_mode: activeMode })
      });
      if (res.ok) {
        setSyncStatus({ type: 'success', message: `${activeMode} shipment database wiped clean.` });
        setCountingQty({});
        setNoProductData([]);
        setExcessQtyFrequency({});
        setScanTape([]);
        setBarcodePrintQueue([]);
        await refreshShipmentListFromDB(activeMode);
      } else {
        throw new Error('Failed to reset backend table.');
      }
    } catch (err: any) {
      setSyncStatus({ type: 'error', message: err.message });
    }
  };

  // Core barcode scan worker (accepts scanned string directly, agnostic to trigger mechanism)
  const executeBarcodeScan = async (cleanValue: string) => {
    if (!cleanValue) return;

    setScanStatus({ type: 'processing', message: `Querying repository: "${cleanValue}"` });

    try {
      const startTime = performance.now();
      const res = await fetch('/api/barcode/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: cleanValue })
      });

      const latency = performance.now() - startTime;
      console.log(`[Scan Engine] Database query responded in ${latency.toFixed(1)}ms`);

      if (res.status === 404) {
        // CASE B: Product does not exist in master products
        const timestampVal = new Date().toLocaleTimeString();
        setNoProductData(prev => [
          {
            value: cleanValue,
            timestamp: timestampVal,
            reason: 'NOT FOUND IN PRODUCTS'
          },
          ...prev
        ]);
        setScanStatus({ 
          type: 'error', 
          message: `Product record missing for Scanned Identifier: "${cleanValue}"` 
        });
        return;
      }

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const product: Product = await res.json();

      // Product exists in 'products' catalog. Let's see if SKU exists in 'shipment_barcode' expected items
      const isExpected = shipmentItems.some(
        item => item.sku.toLowerCase() === product.sku.toLowerCase()
      );

      if (isExpected) {
        // CASE A: SKU is registered on active PO shipment
        // Let's determine if this scan exceeds the remaining expected capacity (ordered_qty - fulfilled_qty)
        const targetItem = shipmentItems.find(item => item.sku.toLowerCase() === product.sku.toLowerCase());
        const orderedCapacity = targetItem ? targetItem.cu_ordered_qty : 0;
        // fulfilled_qty now includes this session's scans; subtract session_qty (as of page load)
        // to get the pre-session baseline for capacity calculation.
        const priorFulfilled = targetItem
          ? Math.max(0, (targetItem.fulfilled_qty || 0) - (targetItem.session_qty || 0))
          : 0;
        const remainingCapacity = Math.max(0, orderedCapacity - priorFulfilled);

        const currentCount = countingQty[product.sku] || 0;
        const nextCount = currentCount + 1;
        const isExcessScan = nextCount > remainingCapacity;

        if (!isExcessScan) {
          setCountingQty(prev => ({
            ...prev,
            [product.sku]: nextCount
          }));

          // Add to active log tape
          setScanTape(prev => [
            {
              sku: product.sku,
              name: product.item_name,
              timestamp: new Date().toLocaleTimeString(),
              isUnexpected: false
            },
            ...prev
          ]);

          setBarcodePrintQueue(prev => [...prev, product.sku]);
          setScanStatus({
            type: 'success',
            message: `RECEIVED: [${product.sku}] ${product.item_name}. Automated label sent to printer.`
          });
          // Persist scan to DB in real-time (fire-and-forget — does not block scanning)
          fetch('/api/shipment/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sku: product.sku, sku_name: product.item_name, product_id: product.product_id, planned_mode: activeMode }),
          }).catch(err => console.warn('[Scan Persist] Failed to write scan to DB:', err));
          // Push print job
          setActivePrintBatch([{ product }]);
        } else {
          // If any quantity is counted as excess, do NOT add it to counted_qty, but solely record inside excess list.
          setExcessQtyFrequency(prevExcess => ({
            ...prevExcess,
            [product.sku]: (prevExcess[product.sku] || 0) + 1
          }));

          // Add to active log tape
          setScanTape(prev => [
            {
              sku: product.sku,
              name: product.item_name,
              timestamp: new Date().toLocaleTimeString(),
              isUnexpected: true
            },
            ...prev
          ]);

          const excessByCount = (excessQtyFrequency[product.sku] || 0) + 1;
          setScanStatus({
            type: 'warning',
            message: `EXCESS SCAN DETECTED: [${product.sku}] ${product.item_name}. Remaining expect capacity was ${remainingCapacity} (Excess added: +${excessByCount}). Queued in overstock list.`
          });
        }

      } else {
        // CASE B: Unexpected SKU (not registered under active shipment)
        // Only retain inside excess frequency list. Do NOT add to counted_qty.
        setExcessQtyFrequency(prevExcess => ({
          ...prevExcess,
          [product.sku]: (prevExcess[product.sku] || 0) + 1
        }));

        // Add to active log tape
        setScanTape(prev => [
          {
            sku: product.sku,
            name: product.item_name,
            timestamp: new Date().toLocaleTimeString(),
            isUnexpected: true
          },
          ...prev
        ]);

        setScanStatus({
          type: 'warning',
          message: `UNEXPECTED SKU SCANNED: [${product.sku}] ${product.item_name}. Added to excess list, NOT printed during scan.`
        });
      }

    } catch (err: any) {
      console.error('[Scan Engine] Exception processing scanned code:', err);
      setScanStatus({
        type: 'error',
        message: `Query failed: ${err.message || 'Database unavailable'}`
      });
    }
  };

  // Scan processor (<100ms response targets) for the form submit
  const handleBarcodeScan = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const cleanValue = barcodeInput.trim();
    if (!cleanValue) return;

    setBarcodeInput('');
    await executeBarcodeScan(cleanValue);
  };

  // Setup global keyboard interceptor for hands-free focus-free scanning in manual/focus-free mode
  useEffect(() => {
    if (locked || scanMode !== 'manual') return;

    let buffer = '';

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // If user is focused on any standard input, textarea, or select outside our main barcode form, skip capture
      const activeEl = document.activeElement;
      if (activeEl && (
        activeEl.tagName === 'INPUT' || 
        activeEl.tagName === 'TEXTAREA' || 
        activeEl.tagName === 'SELECT' ||
        activeEl.getAttribute('contenteditable') === 'true'
      )) {
        if (activeEl === inputRef.current) {
          return; // Let native submit work
        }
        return;
      }

      // Ignore common non-printable actions
      if (
        e.key === 'Tab' || 
        e.key === 'Escape' || 
        e.key === 'Shift' || 
        e.key === 'Control' || 
        e.key === 'Alt' || 
        e.key === 'Meta' ||
        e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
        e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End'
      ) {
        return;
      }

      // Backspace clears last character inside focus-free buffer
      if (e.key === 'Backspace') {
        e.preventDefault();
        buffer = buffer.slice(0, -1);
        setBarcodeInput(buffer);
        return;
      }

      // Enter submits physical barcode scan
      if (e.key === 'Enter') {
        const trimmed = buffer.trim();
        if (trimmed) {
          e.preventDefault();
          executeBarcodeScan(trimmed);
        }
        buffer = '';
        setBarcodeInput('');
        return;
      }

      // Append normal keystrokes
      if (e.key.length === 1) {
        if (e.key === ' ') {
          e.preventDefault();
        }
        buffer += e.key;
        setBarcodeInput(buffer);
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [locked, scanMode, shipmentItems, excessQtyFrequency]);

  // Automatic scan trigger in continuous auto-focus mode:
  // As soon as an item is scanned and populates the text field,
  // it triggers direct print/processing after 200ms of inactivity without manual clicks.
  useEffect(() => {
    if (scanMode !== 'autofocus' || !barcodeInput.trim()) {
      if (autoScanTimeoutRef.current) {
        clearTimeout(autoScanTimeoutRef.current);
        autoScanTimeoutRef.current = null;
      }
      return;
    }

    if (autoScanTimeoutRef.current) {
      clearTimeout(autoScanTimeoutRef.current);
    }

    autoScanTimeoutRef.current = setTimeout(() => {
      const cleanVal = barcodeInput.trim();
      if (cleanVal) {
        setBarcodeInput('');
        executeBarcodeScan(cleanVal);
      }
    }, 200);

    return () => {
      if (autoScanTimeoutRef.current) {
        clearTimeout(autoScanTimeoutRef.current);
      }
    };
  }, [barcodeInput, scanMode]);

  // Triggers print for all labels in the excess frequency list in a single batch
  const handlePrintAllExcessLabels = async () => {
    const finalBatch: Array<{ product: Product }> = [];

    setScanStatus({ type: 'processing', message: 'Compiling batch of excess labels for printer...' });

    try {
      const res = await fetch('/api/barcode/products');
      if (!res.ok) throw new Error('Could not load products to print excess labels.');
      const allProducts: Product[] = await res.json();

      const printedUpdates: { [sku: string]: number } = {};

      for (const sku in excessQtyFrequency) {
        const count = excessQtyFrequency[sku];
        if (count <= 0) continue;

        const matchingProd = allProducts.find(p => p.sku.toLowerCase() === sku.toLowerCase());
        if (matchingProd) {
          printedUpdates[sku] = count;
          for (let i = 0; i < count; i++) {
            finalBatch.push({ product: matchingProd });
          }
        }
      }

      if (finalBatch.length === 0) {
        alert('No excess quantity labels to build.');
        setScanStatus({ type: 'idle', message: 'No excess quantities available to trigger batch print.' });
        return;
      }

      // Whichever excess quantities SKUs are printed MUST be added to counted_qty (countingQty) for that SKU
      setCountingQty(prev => {
        const next = { ...prev };
        for (const sku in printedUpdates) {
          next[sku] = (next[sku] || 0) + printedUpdates[sku];
        }
        return next;
      });

      // And removed from excess stock list
      setExcessQtyFrequency(prev => {
        const next = { ...prev };
        for (const sku in printedUpdates) {
          delete next[sku];
        }
        return next;
      });

      // Add to global logged queue size
      setBarcodePrintQueue(prev => [...prev, ...finalBatch.map(f => f.product.sku)]);

      // Triggers physical continuous print portal
      setActivePrintBatch(finalBatch);

      setScanStatus({
        type: 'success',
        message: `PRINTED: Batch of ${finalBatch.length} excess stock labels. Quantities added to active counted log.`
      });

    } catch (err: any) {
      console.error(err);
      alert('Failed to execute bulk printer job: ' + err.message);
    }
  };

  // Discards current local counting logs to begin a new scan session
  const handleDiscardSession = () => {
    if (window.confirm("ARE YOU ABSOLUTELY SURE? This will permanently discard all current scanned counts and reset the receiving workspace without saving any changes to the database.")) {
      // Reset session_qty in DB so restored counts don't reappear on next refresh
      fetch('/api/shipment/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planned_mode: activeMode }),
      }).catch(err => console.warn('[Discard] Failed to reset session_qty in DB:', err));
      setCountingQty({});
      setNoProductData([]);
      setExcessQtyFrequency({});
      setScanTape([]);
      setBarcodePrintQueue([]);
      setLocked(false);
      setScanStatus({ type: 'idle', message: 'Fulfillment receiving session discarded. Workspace cleared.' });
    }
  };

  // Deprecated/Compatibility helper
  const handleResetSession = () => {
    handleDiscardSession();
  };

  // Confirms the active receiving session: updates shipment_barcode.fulfilled_qty in Postgres database
  const handleConfirmSession = async () => {
    setIsConfirming(true);
    setScanStatus({ type: 'processing', message: 'Saving session quantities to database...' });
    try {
      const res = await fetch('/api/shipment/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planned_mode: activeMode })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Server responded with an error during session update.');
      }

      // Load fresh values from DB so that {ordered_qty - fulfilled_qty} gets updated
      await refreshShipmentListFromDB(activeMode);

      // Clear current counts so operator starts next session on clean slate
      setCountingQty({});
      setNoProductData([]);
      setExcessQtyFrequency({});
      setScanTape([]);
      setBarcodePrintQueue([]);
      setLocked(false);
      setScanStatus({
        type: 'success',
        message: 'Fulfillment session successfully confirmed and logged into the WMS database!'
      });
    } catch (err: any) {
      console.error(err);
      alert('Failed to confirm session in database: ' + err.message);
      setScanStatus({ type: 'error', message: 'Error confirming session. Please try again.' });
    } finally {
      setIsConfirming(false);
    }
  };

  // Exports actively received items, excess, and unresolved scans into a CSV file
  const handleExportWMSReport = () => {
    const lines = [['Section', 'SKU / Code', 'Product Name', 'Ordered Qty', 'Scanned Counted Qty', 'Excess Scanned Qty', 'Notes']];

    // Section 1: matched shipment items that were scanned this session
    shipmentItems.forEach(item => {
      const counted = countingQty[item.sku] || 0;
      const excess = excessQtyFrequency[item.sku] || 0;
      if (counted > 0 || excess > 0) {
        lines.push([
          'SHIPMENT',
          item.sku,
          `"${item.sku_name.replace(/"/g, '""')}"`,
          item.cu_ordered_qty.toString(),
          counted.toString(),
          excess.toString(),
          ''
        ]);
      }
    });

    // Section 2: unexpected SKUs (in excess list but not in expected shipment)
    Object.keys(excessQtyFrequency).forEach(sku => {
      const isExpected = shipmentItems.some(item => item.sku.toLowerCase() === sku.toLowerCase());
      if (!isExpected) {
        lines.push([
          'UNEXPECTED SKU',
          sku,
          '"Unknown — not in active PO"',
          '0',
          '0',
          excessQtyFrequency[sku].toString(),
          'Scanned but not in purchase order'
        ]);
      }
    });

    // Section 3: barcodes with no matching product in catalog
    noProductData.forEach(entry => {
      lines.push([
        'NO PRODUCT DATA',
        `"${entry.value.replace(/"/g, '""')}"`,
        '"—"',
        '0',
        '0',
        '0',
        `"${entry.reason} @ ${entry.timestamp}"`
      ]);
    });

    const csvContent = "data:text/csv;charset=utf-8," + lines.map(e => e.join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `WMS_Fulfillment_Report_${activeMode}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Copy helper for the Apps Script instructions
  const copyAppsScriptToClipboard = () => {
    // Fetch the canonical script from the resources file and write to clipboard
    const lines = [
      '/** Google Apps Script - Code.gs',
      ' * Joins Purchase_Orders + Purchase_Order_Lines to expose planned_mode per line.',
      ' * Sheet columns:',
      ' *   Purchase_Orders     : po_id | planned_mode (AIR or SEA)',
      ' *   Purchase_Order_Lines: po_id | sku | sku_name | ordered_qty | fulfilled_qty',
      ' */',
      'function doGet(e) {',
      '  try {',
      '    var ss = SpreadsheetApp.getActiveSpreadsheet();',
      '    var poMap = {};',
      '    var poSheet = ss.getSheetByName("Purchase_Orders");',
      '    if (poSheet) {',
      '      var poData = poSheet.getDataRange().getValues();',
      '      if (poData.length > 1) {',
      '        var poHeaders = poData[0].map(function(h) { return h.toString().trim().toLowerCase(); });',
      '        var poIdIdx = poHeaders.indexOf("po_id"); if (poIdIdx === -1) poIdIdx = 0;',
      '        var modeIdx = poHeaders.indexOf("planned_mode"); if (modeIdx === -1) modeIdx = 1;',
      '        for (var p = 1; p < poData.length; p++) {',
      '          var poId = (poData[p][poIdIdx] || "").toString().trim();',
      '          var mode = (poData[p][modeIdx] || "").toString().trim().toUpperCase();',
      '          if (poId) { poMap[poId] = (mode === "SEA") ? "SEA" : "AIR"; }',
      '        }',
      '      }',
      '    }',
      '    var sheet = ss.getSheetByName("Purchase_Order_Lines");',
      '    if (!sheet) { sheet = ss.getSheets()[0]; }',
      '    var data = sheet.getDataRange().getValues();',
      '    if (data.length <= 1) { return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON); }',
      '    var headers = data[0].map(function(h) { return h.toString().trim().toLowerCase(); });',
      '    var skuIdx = headers.indexOf("sku"); if (skuIdx === -1) skuIdx = 0;',
      '    var nameIdx = headers.indexOf("sku_name") !== -1 ? headers.indexOf("sku_name") : headers.indexOf("item_name"); if (nameIdx === -1) nameIdx = 1;',
      '    var orderedIdx = headers.indexOf("ordered_qty") !== -1 ? headers.indexOf("ordered_qty") : headers.indexOf("quantity"); if (orderedIdx === -1) orderedIdx = 2;',
      '    var fulfilledIdx = headers.indexOf("fulfilled_qty");',
      '    var poIdLineIdx = headers.indexOf("po_id");',
      '    var resultList = [];',
      '    for (var i = 1; i < data.length; i++) {',
      '      var row = data[i];',
      '      var skuValue = (row[skuIdx] || "").toString().trim();',
      '      if (!skuValue) continue;',
      '      var poId = poIdLineIdx !== -1 ? (row[poIdLineIdx] || "").toString().trim() : "";',
      '      resultList.push({',
      '        sku: skuValue,',
      '        sku_name: nameIdx !== -1 ? (row[nameIdx] || "").toString().trim() : "SKU " + skuValue,',
      '        ordered_qty: parseInt(row[orderedIdx], 10) || 0,',
      '        fulfilled_qty: fulfilledIdx !== -1 ? (parseInt(row[fulfilledIdx], 10) || 0) : 0,',
      '        planned_mode: (poId && poMap[poId]) ? poMap[poId] : "AIR"',
      '      });',
      '    }',
      '    return ContentService.createTextOutput(JSON.stringify(resultList)).setMimeType(ContentService.MimeType.JSON);',
      '  } catch (error) {',
      '    return ContentService.createTextOutput(JSON.stringify({error: true, message: error.toString()})).setMimeType(ContentService.MimeType.JSON);',
      '  }',
      '}'
    ];
    navigator.clipboard.writeText(lines.join('\n'));
    alert('Google Apps Script Code copied to clipboard!');
  };

  // Calculated session statistics
  const totalScannedCount = scanTape.length + noProductData.length;
  
  // Matched products count: how many of the expected rows have physical counted quantity > 0
  const uniqueMatchedProducts = shipmentItems.filter(item => (countingQty[item.sku] || 0) > 0).length;
  
  // Unexpected products count: unique catalog items scanned that were NOT on the shipment list
  const uniqueUnexpectedProducts = Object.keys(excessQtyFrequency).filter(sku => 
    !shipmentItems.some(item => item.sku.toLowerCase() === sku.toLowerCase())
  ).length;

  const totalMissingProductScans = noProductData.length;
  const totalExcessQuantity = Object.keys(excessQtyFrequency).reduce((acc, sku) => acc + (excessQtyFrequency[sku] || 0), 0);
  const totalPrintJobsTriggered = barcodePrintQueue.length;

  // Dynamic filtered rows for scan-driven table: only show row if counting_qty[sku] > 0
  const filteredItems = shipmentItems.filter(item => (countingQty[item.sku] || 0) > 0);

  return (
    <div className="space-y-6">
      
      {/* Module Title Banner */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-900 border border-slate-800 p-6 rounded-2xl gap-4 shadow-xl">
        <div className="space-y-1.5 h-full">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase bg-amber-500/10 border border-amber-500/30 text-amber-400 px-2.5 py-0.5 rounded-md font-bold tracking-wider">
              Warehouse Inbound Receivers
            </span>
            <span className="text-xs uppercase bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 px-2.5 py-0.5 rounded-md font-bold tracking-wider">
              Cumulative Sync Mode
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Shipment Barcode receiving</h1>
          <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
            Scan physical inbound stocks continuously. The BFF layer links barcodes with catalog profiles, manages live receiving sheets, records over-stock variances, and evokes automated thermal label print jobs seamlessly.
          </p>
        </div>

        {/* Quick Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowScriptModal(true)}
            className="flex items-center gap-1.5 text-xs font-semibold py-2 px-3.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-indigo-400 hover:border-indigo-500/30 transition cursor-pointer"
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span>Apps Script</span>
          </button>
        </div>
      </div>

      {/* Mode Sub-Tabs: AIR / SEA */}
      <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1">
        <button
          onClick={() => setActiveMode('AIR')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-bold rounded-lg transition select-none cursor-pointer ${
            activeMode === 'AIR'
              ? 'bg-indigo-600 text-white shadow'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          ✈ AIR Shipment
        </button>
        <button
          onClick={() => setActiveMode('SEA')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-bold rounded-lg transition select-none cursor-pointer ${
            activeMode === 'SEA'
              ? 'bg-cyan-700 text-white shadow'
              : 'text-slate-400 hover:text-white hover:bg-slate-800'
          }`}
        >
          ⚓ SEA Shipment
        </button>
      </div>

      {activeMode === 'SEA' ? (
        <div className="flex flex-col items-center justify-center py-24 bg-slate-900 border border-slate-800 rounded-2xl text-center space-y-4">
          <div className="bg-slate-950 p-5 rounded-full border border-slate-800 text-4xl select-none">⚓</div>
          <div className="space-y-2">
            <h3 className="text-lg font-bold text-slate-200">SEA Shipment — Coming Soon</h3>
            <p className="text-sm text-slate-500 max-w-md">SEA mode scanning and barcode generation will be available in a future update.</p>
          </div>
        </div>
      ) : (
      <>

      {/* Sync Controls — always visible compact bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900 border border-slate-800 rounded-xl px-5 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => handleShipmentSync(false)}
            disabled={syncStatus.type === 'loading'}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold py-2 px-4 rounded-lg transition cursor-pointer select-none"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncStatus.type === 'loading' ? 'animate-spin' : ''}`} />
            <span>Sync Sheet</span>
          </button>

          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <Database className="h-3 w-3 text-indigo-400" />
            <button
              onClick={() => handleShipmentSync(true)}
              disabled={syncStatus.type === 'loading'}
              className="text-indigo-400 hover:text-indigo-300 font-bold underline cursor-pointer disabled:opacity-50"
            >
              Load sandbox demo dataset
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {syncStatus.message && (
            <div className={`flex items-center gap-1.5 text-[11px] ${
              syncStatus.type === 'error' ? 'text-red-400' : syncStatus.type === 'success' ? 'text-emerald-400' : 'text-indigo-400'
            }`}>
              {syncStatus.type === 'error' && <XCircle className="h-3.5 w-3.5 shrink-0" />}
              {syncStatus.type === 'success' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
              {syncStatus.type === 'loading' && <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />}
              <span>{syncStatus.message}</span>
            </div>
          )}
          <button
            onClick={() => handleWipeDatabaseTable()}
            disabled={syncStatus.type === 'loading'}
            className="text-[11px] text-red-400 border border-red-500/20 hover:bg-red-500/10 px-3 py-1.5 rounded-lg transition cursor-pointer disabled:opacity-50 select-none"
          >
            Reset {activeMode} database
          </button>
        </div>
      </div>

      {/* Session Live Statistics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        
        <div className="bg-slate-900 border border-slate-800 p-4.5 rounded-2xl flex flex-col justify-between shadow-lg relative overflow-hidden group">
          <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Total Scanned</span>
          <div className="text-2xl font-bold font-mono text-white mt-1.5">{totalScannedCount}</div>
          <p className="text-[10px] text-slate-500 mt-1">Catalog items scans</p>
          <div className="absolute right-3 bottom-3 text-slate-850 h-8 w-8 pointer-events-none stroke-current">
            <BarChart4 className="h-full w-full" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-4.5 rounded-2xl flex flex-col justify-between shadow-lg relative overflow-hidden group">
          <span className="text-xs text-emerald-400 font-semibold uppercase tracking-wider">Matched expected</span>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-1.5">{uniqueMatchedProducts}</div>
          <p className="text-[10px] text-slate-500 mt-1">Expected SKU items matched</p>
          <div className="absolute right-3 bottom-3 text-slate-850 h-8 w-8 pointer-events-none stroke-current">
            <CheckCircle2 className="h-full w-full" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-4.5 rounded-2xl flex flex-col justify-between shadow-lg relative overflow-hidden group">
          <span className="text-xs text-amber-400 font-semibold uppercase tracking-wider">Unexpected SKUs</span>
          <div className="text-2xl font-bold font-mono text-amber-400 mt-1.5">{uniqueUnexpectedProducts}</div>
          <p className="text-[10px] text-slate-500 mt-1">Unique unexpected codes</p>
          <div className="absolute right-3 bottom-3 text-slate-850 h-8 w-8 pointer-events-none stroke-current">
            <AlertTriangle className="h-full w-full" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-4.5 rounded-2xl flex flex-col justify-between shadow-lg relative overflow-hidden group">
          <span className="text-xs text-red-400 font-semibold uppercase tracking-wider">Missing Product</span>
          <div className="text-2xl font-bold font-mono text-red-400 mt-1.5">{totalMissingProductScans}</div>
          <p className="text-[10px] text-slate-500 mt-1">Codes absent in catalog</p>
          <div className="absolute right-3 bottom-3 text-slate-850 h-8 w-8 pointer-events-none stroke-current">
            <ShieldAlert className="h-full w-full" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-4.5 rounded-2xl flex flex-col justify-between shadow-lg relative overflow-hidden group">
          <span className="text-xs text-indigo-400 font-semibold uppercase tracking-wider">Excess quantity</span>
          <div className="text-2xl font-bold font-mono text-indigo-400 mt-1.5">{totalExcessQuantity}</div>
          <p className="text-[10px] text-slate-500 mt-1">Surplus physical stocks</p>
          <div className="absolute right-3 bottom-3 text-slate-850 h-8 w-8 pointer-events-none stroke-current">
            <Sparkles className="h-full w-full" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 p-4.5 rounded-2xl flex flex-col justify-between shadow-lg relative overflow-hidden group">
          <span className="text-xs text-purple-400 font-semibold uppercase tracking-wider">Print Queue</span>
          <div className="text-2xl font-bold font-mono text-purple-400 mt-1.5">{totalPrintJobsTriggered}</div>
          <p className="text-[10px] text-slate-500 mt-1">Labels sent to print logs</p>
          <div className="absolute right-3 bottom-3 text-slate-850 h-8 w-8 pointer-events-none stroke-current">
            <Printer className="h-full w-full" />
          </div>
        </div>

      </div>

      {/* Primary Receiving Interface */}
      {!locked ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Block: Search Barcode & Live Scan Status */}
          <div className="lg:col-span-12 bg-slate-900 border border-slate-850 rounded-2xl p-6 shadow-xl space-y-4">
            
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <h2 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2 select-none">
                <Terminal className="h-4 w-4 text-indigo-400" />
                <span>Continuous Laser Barcode Input</span>
              </h2>
              
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mr-1">Scanner Mode:</span>
                <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setScanMode('autofocus')}
                    className={`px-3 py-1 text-[10.5px] font-bold rounded-md transition select-none cursor-pointer ${
                      scanMode === 'autofocus'
                        ? 'bg-indigo-600 text-white shadow'
                        : 'text-slate-400 hover:text-white hover:bg-slate-900'
                    }`}
                    title="Continuous Auto-Focus: Cursor is forcefully focused in input. Scanned items print directly with no clicking required!"
                  >
                    🎯 Continuous Auto-Focus
                  </button>
                  <button
                    type="button"
                    onClick={() => setScanMode('manual')}
                    className={`px-3 py-1 text-[10.5px] font-bold rounded-md transition select-none cursor-pointer ${
                      scanMode === 'manual'
                        ? 'bg-indigo-600 text-white shadow'
                        : 'text-slate-400 hover:text-white hover:bg-slate-900'
                    }`}
                    title="Manual & Focus-Free: Type manually or scan physically anywhere on-screen. Clicking 'Trigger Scan' or hitting Enter submits."
                  >
                    ✏️ Manual & Focus-Free
                  </button>
                </div>
              </div>
            </div>

            {scanMode === 'manual' && (
              <div className="text-[11px] text-indigo-300 bg-indigo-950/20 px-3.5 py-2 rounded-lg border border-indigo-500/10 flex items-center gap-1.5 select-none">
                <span>🟢</span>
                <span><strong>Manual & Focus-Free Mode Active:</strong> You can type manually below, or scan physically anywhere on this screen. Clicking <strong>"Trigger Scan"</strong> or pressing Enter will submit.</span>
              </div>
            )}

            {/* SCAN FORM CONTROL */}
            <form onSubmit={handleBarcodeScan} className="relative">
              <input
                ref={inputRef}
                type="text"
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                placeholder={
                  scanMode === 'autofocus'
                    ? "🎯 AUTO-FOCUS SCAN ACTIVE: KEEP SCANNED SKU HERE FOR DIRECT PRINT (AUTO PROCESS IN 200MS)..."
                    : "✏️ TYPE SKU / SCAN DIRECTLY ANYWHERE (CLICK 'TRIGGER SCAN' OR PRESS ENTER TO SUBMIT)..."
                }
                className="w-full bg-slate-950 border border-slate-850 rounded-xl px-4.5 py-4 text-xs font-mono tracking-widest text-white placeholder:text-slate-605 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-all text-center uppercase"
              />
              {scanMode === 'manual' && (
                <button 
                  type="submit" 
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-indigo-650 hover:bg-indigo-600 rounded-lg text-white font-medium text-[10px] tracking-wide cursor-pointer"
                >
                  Trigger Scan
                </button>
              )}
            </form>

            {/* Live feedback alert indicator panel */}
            <div className={`p-3.5 rounded-xl border text-xs flex items-center gap-2.5 select-none ${
              scanStatus.type === 'error' 
                ? 'bg-red-500/10 border-red-500/20 text-red-400' 
                : scanStatus.type === 'success' 
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 font-medium' 
                  : scanStatus.type === 'warning' 
                    ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' 
                    : 'bg-slate-950 border-slate-850 text-slate-400'
            }`}>
              {scanStatus.type === 'error' && <XCircle className="h-4 w-4 shrink-0 text-red-400" />}
              {scanStatus.type === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 animate-bounce" />}
              {scanStatus.type === 'warning' && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />}
              {scanStatus.type === 'processing' && <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-indigo-400" />}
              {scanStatus.type === 'idle' && <Terminal className="h-4 w-4 shrink-0 text-slate-500" />}
              <span>{scanStatus.message}</span>
            </div>

          </div>

          {/* Dual Panel Workspace */}
          {/* Main List: Expected Shipment Overview Table */}
          <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3 select-none">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
                <h2 className="text-sm font-bold text-slate-200 uppercase tracking-wider">
                  Active Shipment Overview Table
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-3 select-none">
                {shipmentItems.length > 0 && (
                  <span className="text-[10px] font-bold text-slate-400 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-850">
                    Expected Lines in Expected PO: {shipmentItems.length} SKUs
                  </span>
                )}
              </div>
            </div>

            {loadingItems ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-2 select-none">
                <RefreshCw className="h-8 w-8 text-indigo-500 animate-spin" />
                <span className="text-xs text-slate-400 font-semibold">Retrieving shipment rows from table cache...</span>
              </div>
            ) : shipmentItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center space-y-3 px-4 select-none">
                <div className="bg-slate-950 p-4 rounded-full border border-slate-850 text-slate-700">
                  <Inbox className="h-8 w-8" />
                </div>
                <div className="space-y-1">
                  <span className="block text-xs font-bold text-slate-300">No active shipment data imported</span>
                  <p className="text-[11px] text-slate-500 max-w-sm">
                    Connect a Google Sheet or click <strong>"Load sandbox demo dataset"</strong> in the integrations config above to seed the inventory table.
                  </p>
                </div>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center space-y-3 px-4 select-none">
                <div className="bg-slate-950 p-4 rounded-full border border-slate-850 text-slate-700/50">
                  <Inbox className="h-8 w-8 text-indigo-500/40 animate-pulse" />
                </div>
                <div className="space-y-1">
                  <span className="block text-xs font-bold text-slate-300">No active scans recorded yet</span>
                  <p className="text-[11px] text-slate-500 max-w-sm">
                    Start scanning barcodes physically or manually above to populate receiving lines. Uncheck <strong>"Show Only Active Scans"</strong> if you want to view all expected lines.
                  </p>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[500px]">
                  <thead>
                    <tr className="border-b border-slate-800 text-[10.5px] uppercase font-bold text-slate-400 select-none">
                      <th className="py-2.5 px-3">SKU</th>
                      <th className="py-2.5 px-3">Product Name</th>
                      <th className="py-2.5 px-3 text-right">Ordered Qty</th>
                      <th className="py-2.5 px-3 text-right">Counted Qty</th>
                      <th className="py-2.5 px-3 text-right">Remaining Qty</th>
                      <th className="py-2.5 px-3 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-850/60 text-xs">
                    {filteredItems.map((item) => {
                      const counted = countingQty[item.sku] || 0;
                      // fulfilled_qty includes this session; remove session_qty (at load) for prior baseline
                      const priorFulfilled = Math.max(0, (item.fulfilled_qty || 0) - (item.session_qty || 0));
                      const remaining = Math.max(0, item.cu_ordered_qty - priorFulfilled - counted);

                      let statusNode = (
                        <span className="bg-slate-950 border border-slate-850 text-slate-500 px-2 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wider">
                          Pending
                        </span>
                      );

                      if (counted > 0) {
                        if (counted === Math.max(0, item.cu_ordered_qty - priorFulfilled)) {
                          statusNode = (
                            <span className="bg-emerald-500/10 border border-emerald-500/35 text-emerald-400 px-2 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wider">
                              Completed
                            </span>
                          );
                        } else {
                          statusNode = (
                            <span className="bg-amber-500/10 border border-amber-500/35 text-amber-400 px-2 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wider">
                              Pending
                            </span>
                          );
                        }
                      } else {
                        statusNode = (
                          <span className="bg-slate-950 border border-slate-800 text-slate-500 px-2 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wider">
                            Unscanned
                          </span>
                        );
                      }

                      return (
                        <tr key={item.sku} className="hover:bg-slate-850/20 transition duration-100">
                          <td className="py-2.5 px-3 font-mono font-bold text-indigo-400">{item.sku}</td>
                          <td className="py-2.5 px-3 text-slate-300 font-medium truncate max-w-[200px]" title={item.sku_name}>
                            {item.sku_name}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-slate-400 font-semibold text-xs">
                            <div>{item.cu_ordered_qty}</div>
                            {priorFulfilled > 0 && (
                              <div className="text-[10px] text-slate-500 font-normal">Prior Fulfilled: {priorFulfilled}</div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-white">{counted}</td>
                          <td className={`py-2.5 px-3 text-right font-mono font-bold ${remaining === 0 ? 'text-emerald-400' : 'text-slate-400'}`}>
                            {remaining}
                          </td>
                          <td className="py-2.5 px-3 text-center">{statusNode}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Right Panel: Live Scanning Tape */}
          <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <h2 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2 border-b border-slate-800 pb-3 select-none">
              <Terminal className="h-4 w-4 text-purple-400" />
              <span>Live Scanning Tape</span>
            </h2>

            {scanTape.length === 0 && noProductData.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-16 text-slate-500 text-[11px] space-y-2 select-none">
                <Terminal className="h-6 w-6 text-slate-700" />
                <span>Historical logs are currently empty. Scanner is primed for input.</span>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1 scrollbar-thin">
                {/* Simulated scan entries with colorful status indicators */}
                {scanTape.map((log, index) => (
                  <div 
                    key={index} 
                    className={`p-3 rounded-xl border text-[11px] leading-snug space-y-1 transition duration-150 ${
                      log.isUnexpected 
                        ? 'bg-amber-500/5 border-amber-500/20 text-amber-300' 
                        : 'bg-slate-950 border-slate-850 text-slate-300'
                    }`}
                  >
                    <div className="flex justify-between items-center text-[10px] text-slate-500 select-none">
                      <span className="font-mono">{log.timestamp}</span>
                      <span className={`font-bold uppercase tracking-wider ${log.isUnexpected ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {log.isUnexpected ? 'Unexpected stock' : 'Fulfillment match'}
                      </span>
                    </div>
                    <div className="font-bold flex items-center gap-1.5 font-mono text-[11.5px] text-indigo-400">
                      <span>{log.sku}</span>
                    </div>
                    <p className="truncate font-semibold text-slate-200 text-xs">{log.name}</p>
                  </div>
                ))}

                {/* Show any absent products logged in same feed with striking red highlight */}
                {noProductData.map((log, index) => (
                  <div 
                    key={`missing-${index}`} 
                    className="p-3 rounded-xl border border-red-500/20 bg-red-500/5 text-red-300 text-[11px] leading-snug space-y-1"
                  >
                    <div className="flex justify-between items-center text-[10px] text-slate-500 select-none">
                      <span className="font-mono">{log.timestamp}</span>
                      <span className="font-bold text-red-400 uppercase tracking-wider">Unresolved error</span>
                    </div>
                    <div className="font-bold font-mono text-[11.5px] text-red-400">
                      <span>Code: "{log.value}"</span>
                    </div>
                    <p className="font-semibold text-xs text-red-300">{log.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Action buttons at base */}
          <div className="lg:col-span-12 flex justify-end">
            <button
              onClick={() => {
                if (window.confirm("Verify: Are you ready to finish scanning? This locks the active receiving sessions, totals actual quantities, and generates reconciliation reports.")) {
                  setLocked(true);
                  // Ensure we scroll window elegantly to show summary nicely
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }
              }}
              disabled={shipmentItems.length === 0}
              className="w-full sm:w-auto bg-red-650 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold uppercase tracking-wider py-3.5 px-8 rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-red-500/10 cursor-pointer select-none"
            >
              <Lock className="h-4 w-4" />
              <span>No More Shipments To Scan</span>
            </button>
          </div>

        </div>
      ) : (
        /* LOCK/SUMMARY SCREEN PATTERN */
        <div className="space-y-6">
          
          {/* Locked Header Info Block */}
          <div className="bg-red-650/10 border border-red-500/35 p-6 rounded-2xl flex flex-col sm:flex-row items-center gap-5 shadow-inner">
            <div className="bg-red-600 text-white p-4.5 rounded-full shadow-lg shadow-red-500/20 shrink-0">
              <Lock className="h-7 w-7" />
            </div>
            <div className="space-y-1.5 text-center sm:text-left flex-grow">
              <h2 className="text-lg font-bold text-white tracking-wide">Fulfillment Session Locked & Sealed</h2>
              <p className="text-xs text-red-300 max-w-3xl leading-relaxed">
                Scanning execution is closed. The summary screen displays physical receipt variances, excess quantities to log inside WMS inventories, and invalid barcodes detected for label reprint.
              </p>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <button
                onClick={handleResetSession}
                className="bg-slate-900 border border-slate-800 text-slate-300 hover:text-white px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer"
              >
                <Unlock className="h-4 w-4" />
                <span>Begin New Session</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* Excess Quantity Reconciliation Screen */}
            <div className="lg:col-span-12 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-800 pb-3">
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-slate-200 uppercase tracking-widest flex items-center gap-2 select-none">
                    <Sparkles className="h-4 w-4 text-indigo-400" />
                    <span>Excess Quantity Products</span>
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Physical stock items received whose quantities exceeded purchase order lines or are entirely unexpected.
                  </p>
                </div>

                {/* Print button for all overstocked lines */}
                {Object.keys(excessQtyFrequency).length > 0 && (
                  <button
                    onClick={handlePrintAllExcessLabels}
                    className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-wider py-2.5 px-5 rounded-lg flex items-center justify-center gap-2.5 transition cursor-pointer select-none"
                  >
                    <Printer className="h-4 w-4" />
                    <span>Print All Excess Labels ({totalExcessQuantity})</span>
                  </button>
                )}
              </div>

              {Object.keys(excessQtyFrequency).length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-slate-500 space-y-2 select-none">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                  <span className="text-xs font-bold text-slate-300">Perfect Reconciliation — No Excess Found</span>
                  <p className="text-[10px] text-slate-500">Every scanned barcode matched expect quotas perfectly.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-800 text-[10.5px] uppercase font-bold text-slate-400 select-none">
                        <th className="py-2.5 px-3">SKU</th>
                        <th className="py-2.5 px-3">Product Name</th>
                        <th className="py-2.5 px-3 text-right">Excess Scanned Qty</th>
                        <th className="py-1 px-3 text-center">Batch Label Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-850/60 text-xs">
                      {Object.keys(excessQtyFrequency).map((sku) => {
                        const count = excessQtyFrequency[sku];
                        // Try matching in active shipments first, then catalog
                        const matchInShipment = shipmentItems.find(item => item.sku.toLowerCase() === sku.toLowerCase());
                        const name = matchInShipment ? matchInShipment.sku_name : `Unexpected SKU ${sku}`;

                        return (
                          <tr key={sku} className="hover:bg-slate-850/20 transition">
                            <td className="py-2.5 px-3 font-mono font-bold text-indigo-400">{sku}</td>
                            <td className="py-2.5 px-3 text-slate-300 font-medium truncate max-w-[300px]" title={name}>
                              {name}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono font-bold text-white pr-8">
                              <span className="bg-indigo-500/10 border border-indigo-400/20 text-indigo-400 font-semibold px-2 py-0.5 rounded font-mono">
                                +{count}
                              </span>
                            </td>
                            <td className="py-1 px-3 text-center">
                              <button
                                onClick={async () => {
                                  try {
                                    // Retrieve all catalog details to find the exact configuration of this custom product
                                    const res = await fetch('/api/barcode/products');
                                    if (res.ok) {
                                      const all: Product[] = await res.json();
                                      const exactProd = all.find(p => p.sku.toLowerCase() === sku.toLowerCase());
                                      if (exactProd) {
                                        // Build print jobs arrays matching excess amount
                                        const printJobs: Array<{ product: Product }> = Array.from({ length: count }).map(() => ({
                                          product: exactProd
                                        }));
                                        setActivePrintBatch(printJobs);
                                        setBarcodePrintQueue(prev => [...prev, ...printJobs.map(j => j.product.sku)]);

                                        // Whichever excess quantities SKUs are printed MUST be added to counted_qty (countingQty) for that SKU
                                        setCountingQty(prev => ({
                                          ...prev,
                                          [sku]: (prev[sku] || 0) + count
                                        }));

                                        // And removed from excess log list
                                        setExcessQtyFrequency(prev => {
                                          const next = { ...prev };
                                          delete next[sku];
                                          return next;
                                        });
                                      } else {
                                        alert('Product details not found in active catalog database.');
                                      }
                                    }
                                  } catch (err) {
                                    console.error('Print trigger failure:', err);
                                  }
                                }}
                                className="inline-flex items-center gap-1.5 bg-slate-950 hover:bg-slate-900 border border-slate-800 text-[10.5px] font-semibold text-slate-300 py-1.5 px-3 rounded-lg hover:text-white transition cursor-pointer select-none"
                              >
                                <Printer className="h-3 w-3" />
                                <span>Print ({count}) Labels</span>
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Unmatched Scanned Barcodes (Missing Product Data Section) */}
            <div className="lg:col-span-12 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4 opacity-75">
              
              <div className="border-b border-slate-800 pb-3">
                <h3 className="text-sm font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2 select-none">
                  <ShieldAlert className="h-4 w-4 text-slate-500" />
                  <span>Unresolved Scanned Identifiers (No Product Data)</span>
                </h3>
                <p className="text-[11px] text-slate-500">
                  Scanned barcode codes that could not be reconciled against standard database products. These must be registered inside master catalogs before labels can print.
                </p>
              </div>

              {noProductData.length === 0 ? (
                <div className="text-center py-8 text-slate-500 text-xs italic">
                  No invalid scans logged during this receiving session.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-[10.5px] uppercase font-bold text-slate-500 select-none">
                        <th className="py-2.5 px-3">Scanned Code Value</th>
                        <th className="py-2.5 px-3">Logged Timestamp</th>
                        <th className="py-2.5 px-3">Reconciliation Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-850/65 text-slate-400">
                      {noProductData.map((log, idx) => (
                        <tr key={idx} className="hover:bg-slate-900/40">
                          <td className="py-2.5 px-3 font-mono text-red-400 font-bold tracking-wider">{log.value}</td>
                          <td className="py-2.5 px-3 font-mono text-slate-500">{log.timestamp}</td>
                          <td className="py-2.5 px-3">
                            <span className="text-[10px] font-bold bg-slate-950 border border-slate-850 text-slate-500 px-2 py-0.5 rounded uppercase">
                              {log.reason}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Reconciliation and Locked Session Action Grid */}
            <div className="lg:col-span-12 bg-slate-900 border border-slate-850 p-6 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3 border-b sm:border-b-0 border-slate-800 pb-2 sm:pb-0 select-none">
                <ClipboardCheck className="h-5 w-5 text-indigo-400" />
                <span className="text-xs text-slate-400 font-medium"> Confirm matching counts, export session reports, or discard: </span>
              </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
                
                {/* Leftmost side action: Discard Session */}
                <button
                  type="button"
                  onClick={handleDiscardSession}
                  className="bg-red-500/10 border border-red-500/25 hover:bg-red-500/20 text-red-400 text-[10.5px] font-bold uppercase tracking-wider py-3 px-6 rounded-xl transition cursor-pointer select-none text-center"
                >
                  Discard Session
                </button>

                {/* Middle/Retained action: Export WMS Report */}
                <button
                  type="button"
                  onClick={handleExportWMSReport}
                  className="bg-slate-950 border border-slate-800 hover:bg-slate-855 text-slate-300 text-[10.5px] font-bold uppercase tracking-wider py-3 px-6 rounded-xl transition cursor-pointer select-none text-center"
                >
                  Export WMS Report
                </button>

                {/* Rightmost side action: Confirm Session */}
                <button
                  type="button"
                  onClick={handleConfirmSession}
                  disabled={isConfirming}
                  className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[10.5px] font-bold uppercase tracking-wider py-3 px-6 rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer select-none"
                >
                  {isConfirming ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Confirming...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Confirm Session</span>
                    </>
                  )}
                </button>

              </div>
            </div>

          </div>
        </div>
      )}

      </>
      )}

      {/* PDF CAPTURE: Off-screen container for html2canvas.
          Rendered whenever silent print or PDF download is needed. */}
      {(SILENT_PRINT || PDF_ENABLE) && activePrintBatch.length > 0 && (
        <div
          ref={pdfContainerRef}
          style={{ position: 'fixed', left: '-9999px', top: 0, background: '#fff', pointerEvents: 'none' }}
          aria-hidden="true"
        >
          {activePrintBatch.map((job, idx) => (
            <div key={idx} className="print-label-item" style={{ width: '50mm', height: '30mm' }}>
              <BarcodePreview product={job.product} scale={1.0} batchNo={generateShipmentBatchNo(activeMode)} />
            </div>
          ))}
        </div>
      )}

      {/* DOCUMENT PRINT PORTAL: always rendered so window.print() fallback shows labels correctly */}
      {activePrintBatch.length > 0 && typeof document !== 'undefined' && createPortal(
        <div id="print-only-area" style={{ backgroundColor: '#ffffff' }}>
          {activePrintBatch.map((job, idx) => (
            <div key={idx} className="print-label-item">
              <BarcodePreview product={job.product} scale={1.0} batchNo={generateShipmentBatchNo(activeMode)} />
            </div>
          ))}
        </div>,
        document.body
      )}

      {/* GOOGLE APPS SCRIPT COPYING INSTRUMENTATION DIALOG */}
      {showScriptModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-fade-in text-slate-100">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4">
            
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5 text-emerald-400" />
                <h3 className="text-md font-bold text-white tracking-wide">Google Apps Script Implementation Guide</h3>
              </div>
              <button 
                onClick={() => setShowScriptModal(false)}
                className="text-slate-400 hover:text-white transition font-bold text-sm bg-slate-800 h-6 w-6 rounded-full flex items-center justify-center cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2 text-xs text-slate-300">
              <p>Deploy this script in your Google Spreadsheet. It reads two sheets and joins them by <span className="font-mono text-amber-400">po_id</span>:</p>
              <ol className="list-decimal pl-5 space-y-1.5 text-slate-400">
                <li>Sheet <strong className="text-white font-mono bg-slate-950 px-1 py-0.5 rounded">Purchase_Orders</strong> — columns: <span className="font-mono text-emerald-400">po_id</span>, <span className="font-mono text-amber-400">planned_mode</span> (AIR or SEA).</li>
                <li>Sheet <strong className="text-white font-mono bg-slate-950 px-1 py-0.5 rounded">Purchase_Order_Lines</strong> — columns: <span className="font-mono text-emerald-400">po_id</span>, <span className="font-mono text-indigo-400">sku</span>, <span className="font-mono text-indigo-400">sku_name</span>, <span className="font-mono text-indigo-400">ordered_qty</span>, <span className="font-mono text-slate-400">fulfilled_qty</span>.</li>
                <li>Go to <strong className="text-slate-200">Extensions &gt; Apps Script</strong>, paste the copied script, save.</li>
                <li>Deploy as <strong>Web App</strong>, set access to <strong>"Anyone"</strong>, copy the URL into the integrations config.</li>
              </ol>
            </div>

            {/* Script preview code box */}
            <div className="relative">
              <pre className="bg-slate-950 border border-slate-850 p-4.5 rounded-xl text-[11px] font-mono leading-relaxed overflow-x-auto max-h-[220px] text-indigo-300 scrollbar-thin">
{`function doGet(e) {
  // Build po_id → planned_mode map from Purchase_Orders sheet
  var poMap = {};
  var poSheet = ss.getSheetByName("Purchase_Orders");
  if (poSheet) { /* read po_id + planned_mode columns ... */ }

  // Read Purchase_Order_Lines and join with poMap
  var sheet = ss.getSheetByName("Purchase_Order_Lines");
  // ... iterate rows, look up plannedMode = poMap[poId] || "AIR"
  resultList.push({
    sku, sku_name, ordered_qty, fulfilled_qty,
    planned_mode: plannedMode   // "AIR" or "SEA"
  });
`}
              </pre>
              <button
                onClick={copyAppsScriptToClipboard}
                className="absolute right-3.5 top-3.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[10.5px] font-bold py-1.5 px-3.5 rounded-lg flex items-center gap-1 transition cursor-pointer select-none"
              >
                <Copy className="h-3.5 w-3.5" />
                <span>Copy Script</span>
              </button>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-800">
              <button
                onClick={() => setShowScriptModal(false)}
                className="bg-slate-850 hover:bg-slate-800 text-slate-350 text-xs font-semibold py-2 px-5 rounded-lg cursor-pointer select-none"
              >
                Dismiss Window
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
