import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import JsBarcode from 'jsbarcode';
import { ArrowLeft, FileDown, Printer, Search, RefreshCw, AlertCircle, PackageSearch, CheckCircle2, XCircle } from 'lucide-react';
import { BarcodeGeneratorService } from '../../../shared/services/BarcodeGeneratorService';
import { PdfService } from '../../../shared/services/PdfService';

const APP_SCRIPT_FOR_BARCODE = import.meta.env.VITE_APP_SCRIPT_FOR_BARCODE === 'true';

// Print dimensions for the two header barcodes on the receiving sheet.
// A standard product-label barcode elsewhere in this app renders at 10mm tall
// (see BarcodePreview.tsx) — this is a little taller than that for easier
// scanning. Width is intentionally NOT fixed/clamped: it's left to scale
// naturally from the barcode's own module count at a safe, standard bar
// width, so longer values simply render wider instead of getting squeezed
// into a fixed box (which is what made earlier attempts unscannable / an
// oddly near-square shape).
const RECEIVING_SHEET_BARCODE_HEIGHT_MM = 15;
const RECEIVING_SHEET_BARCODE_MODULE_WIDTH_MM = 0.3; // standard safe bar width for reliable scanning
// Raster resolution used when generating the barcode PNG (~300 DPI equivalent).
const BARCODE_PX_PER_MM = 12;

/**
 * Renders a barcode to a PNG data URL via an offscreen <canvas>, instead of an
 * inline <svg>. html2canvas (used by PdfService for the PDF export) has known
 * unreliable support for capturing live <svg> elements — that was the actual
 * cause of the PO Ref No. barcode coming out unscannable in the exported PDF,
 * independent of any sizing math. A rasterized <img> is captured faithfully.
 */
function renderReceivingSheetBarcodePng(value: string): string | null {
  const v = value.trim();
  if (!v) return null;

  const format = BarcodeGeneratorService.detectFormat(v);
  const barcodeFormat = format === 'EAN13' ? 'EAN13' : format === 'UPC' ? 'UPC' : 'CODE128';
  const heightPx = RECEIVING_SHEET_BARCODE_HEIGHT_MM * BARCODE_PX_PER_MM;
  const moduleWidthPx = RECEIVING_SHEET_BARCODE_MODULE_WIDTH_MM * BARCODE_PX_PER_MM;

  try {
    const canvas = document.createElement('canvas');
    JsBarcode(canvas, v, {
      format: barcodeFormat,
      width: moduleWidthPx,
      height: heightPx,
      displayValue: false,
      margin: Math.round(moduleWidthPx * 10), // standard ~10-module quiet zone each side
      background: '#FFFFFF',
      lineColor: '#000000',
    });
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('[Receiving Sheet Barcode] render failed:', err);
    return null;
  }
}

function ReceivingSheetBarcode({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    setDataUrl(renderReceivingSheetBarcodePng(value));
  }, [value]);

  if (!dataUrl) return null;

  return (
    <img
      src={dataUrl}
      alt={value}
      style={{ display: 'block', margin: '0 auto', height: `${RECEIVING_SHEET_BARCODE_HEIGHT_MM}mm`, width: 'auto' }}
    />
  );
}

/**
 * A spinner that keeps animating even while PdfService has disabled every
 * stylesheet on the page (see the overlay below) — CSS `animate-spin` would
 * freeze in that window since it depends on a stylesheet's @keyframes. SMIL
 * (<animateTransform>) is part of the SVG itself, not a stylesheet, so it's
 * unaffected.
 */
function InlineSpinner() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="9" stroke="#818cf8" strokeWidth="3" strokeLinecap="round" strokeDasharray="42 14" fill="none">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

interface ReceivingSheetLine {
  line_id: string;
  po_id: string;
  po_ref_no: string | null;
  item_sku: string;
  ean_fnsku: string | null;
  item_name: string;
  qty: number;
  pending_qty: number;
  shipment_id: string | null;
}

interface SearchResult {
  po_id: string | null;
  po_ref_no: string | null;
  shipment_id: string | null;
  batch_id: string | null;
  lines: ReceivingSheetLine[];
}

interface DownloadReceivingSheetProps {
  onBack: () => void;
}

// Conservative row count that reliably fits the ~152mm of table space left
// on a 297×210mm landscape page after the header block and padding. Any
// overflow beyond this spills onto additional pages instead of being clipped.
const ROWS_PER_PAGE = 20;

const cellStyle: React.CSSProperties = {
  border: '1px solid #000000',
  padding: '2mm',
  textAlign: 'left',
  fontSize: '9px',
};

const headerCellStyle: React.CSSProperties = {
  ...cellStyle,
  fontWeight: 700,
  backgroundColor: '#ffffff',
};

export function DownloadReceivingSheet({ onBack }: DownloadReceivingSheetProps) {
  // Search fields are seeded from the URL (rs_-prefixed to avoid colliding with
  // the parent ShipmentBarcodeForm's own shipment_id/batch_id params) so a
  // shared/bookmarked link, or a refresh, restores the last search.
  const [searchParams, setSearchParams] = useSearchParams();
  const [poId, setPoId] = useState(() => searchParams.get('rs_po_id') || '');
  const [shipmentId, setShipmentId] = useState(() => searchParams.get('rs_shipment_id') || '');
  const [poRefNo, setPoRefNo] = useState(() => searchParams.get('rs_po_ref_no') || '');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  // Which PDF action is currently running — also drives the full-screen overlay
  // that masks the brief unstyled flash PdfService causes while it disables
  // stylesheets during capture.
  const [busyAction, setBusyAction] = useState<'download' | 'print' | null>(null);

  const runSearch = async (po_id: string, shipment_id: string, po_ref_no: string) => {
    const p = po_id.trim(), s = shipment_id.trim(), r = po_ref_no.trim();
    if (!p && !s && !r) {
      setError('Enter a PO ID, Shipment ID, or PO Ref No. to search.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams();
      if (p) params.set('po_id', p);
      else if (s) params.set('shipment_id', s);
      else if (r) params.set('po_ref_no', r);

      const res = await fetch(`/api/receiving-sheet/search?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.lines?.length) {
        setError('No matching PO lines found.');
        return;
      }
      setResult(data);
      setPoId(data.po_id || '');
      setShipmentId(data.shipment_id || '');
      setPoRefNo(data.po_ref_no || '');
      // Reflect the resolved search in the URL (replace, so repeated searches
      // don't spam browser history) — makes the current result shareable.
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        data.po_id ? next.set('rs_po_id', data.po_id) : next.delete('rs_po_id');
        data.shipment_id ? next.set('rs_shipment_id', data.shipment_id) : next.delete('rs_shipment_id');
        data.po_ref_no ? next.set('rs_po_ref_no', data.po_ref_no) : next.delete('rs_po_ref_no');
        return next;
      }, { replace: true });
    } catch (err: any) {
      setError(err.message || 'Search failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    await runSearch(poId, shipmentId, poRefNo);
  };

  // Auto-run once on mount if the URL already carries a search (shared link / refresh).
  useEffect(() => {
    if (poId || shipmentId || poRefNo) {
      runSearch(poId, shipmentId, poRefNo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClear = () => {
    setPoId(''); setShipmentId(''); setPoRefNo('');
    setResult(null); setError(null);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('rs_po_id'); next.delete('rs_shipment_id'); next.delete('rs_po_ref_no');
      return next;
    }, { replace: true });
  };

  // Chunk lines across multiple printable pages so overflow spills onto
  // additional sheets instead of being cut off on one fixed-height page.
  const linePages = useMemo<ReceivingSheetLine[][]>(() => {
    if (!result?.lines.length) return [];
    const chunks: ReceivingSheetLine[][] = [];
    for (let i = 0; i < result.lines.length; i += ROWS_PER_PAGE) {
      chunks.push(result.lines.slice(i, i + ROWS_PER_PAGE));
    }
    return chunks;
  }, [result]);

  // Give the browser one real paint of the busy overlay before PdfService's
  // synchronous stylesheet-disable step runs — otherwise the overlay's state
  // update and the disable step can land in the same paint cycle and the
  // flash still shows through.
  const waitForPaint = () =>
    new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  const handleDownload = async () => {
    if (!result?.lines.length) return;
    setBusyAction('download');
    setError(null);
    try {
      await waitForPaint();
      const filename = `Receiving_Sheet_${result.po_ref_no || result.po_id}`;
      await PdfService.exportToPdf('receiving-sheet-print-area', {
        filename,
        widthMm: 297,
        heightMm: 210,
        dpi: 300,
      });
    } catch (err: any) {
      setError(err.message || 'Failed to generate PDF.');
    } finally {
      setBusyAction(null);
    }
  };

  const handlePrint = async () => {
    if (!result?.lines.length) return;
    setBusyAction('print');
    setError(null);
    try {
      await waitForPaint();
      const filename = `Receiving_Sheet_${result.po_ref_no || result.po_id}`;
      await PdfService.printPdf('receiving-sheet-print-area', {
        filename,
        widthMm: 297,
        heightMm: 210,
        dpi: 300,
      });
    } catch (err: any) {
      setError(err.message || 'Failed to print.');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-slate-400 hover:text-white text-[11px] font-bold shrink-0 cursor-pointer transition self-start"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Shipment Barcode
      </button>

      {!APP_SCRIPT_FOR_BARCODE ? (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-xs text-red-300">
          <XCircle className="h-4 w-4 shrink-0" />
          Central DB flow for the receiving sheet is not built yet. Set APP_SCRIPT_FOR_BARCODE=true (and VITE_APP_SCRIPT_FOR_BARCODE=true) to use the Inventory sheet flow.
        </div>
      ) : (
        <>
          {/* Search bar */}
          <form onSubmit={handleSearch} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
              <PackageSearch className="h-3.5 w-3.5 text-indigo-400" />
              Find Receiving Sheet
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1">PO ID</label>
                <input
                  type="text" value={poId} onChange={e => setPoId(e.target.value)}
                  placeholder="e.g. 1746387"
                  className="w-full bg-slate-950 border border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 font-mono transition"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1">Shipment ID</label>
                <input
                  type="text" value={shipmentId} onChange={e => setShipmentId(e.target.value)}
                  placeholder="e.g. 24147"
                  className="w-full bg-slate-950 border border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 font-mono transition"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1">PO Ref No.</label>
                <input
                  type="text" value={poRefNo} onChange={e => setPoRefNo(e.target.value)}
                  placeholder="e.g. 24147-PW"
                  className="w-full bg-slate-950 border border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 font-mono transition"
                />
              </div>
            </div>
            <p className="text-[10px] text-slate-500">Fill in any one field — the other two and the line items will be resolved automatically.</p>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-[11px] font-bold py-2 px-4 rounded-lg transition cursor-pointer select-none"
                >
                  {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  Search
                </button>
                <button
                  type="button" onClick={handleClear}
                  className="text-slate-400 hover:text-white text-[11px] font-bold py-2 px-3 rounded-lg transition cursor-pointer select-none"
                >
                  Clear
                </button>
              </div>

              {/* Print/Download — only once a search has actually resolved lines,
                  and kept on this same top row so they're usable without scrolling. */}
              {result && result.lines.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handlePrint}
                    disabled={busyAction !== null}
                    className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-50 text-white text-[11px] font-bold uppercase tracking-wider py-2 px-4 rounded-lg transition cursor-pointer select-none"
                  >
                    {busyAction === 'print' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                    {busyAction === 'print' ? 'Preparing…' : 'Print'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={busyAction !== null}
                    className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[11px] font-bold uppercase tracking-wider py-2 px-4 rounded-lg transition cursor-pointer select-none"
                  >
                    {busyAction === 'download' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
                    {busyAction === 'download' ? 'Generating PDF…' : 'Download PDF'}
                  </button>
                </div>
              )}
            </div>
          </form>

          {error && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-xs text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {result && result.lines.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                <span className="bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 px-2 py-0.5 rounded font-bold font-mono">PO ID: {result.po_id}</span>
                <span className="bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 px-2 py-0.5 rounded font-bold font-mono">Shipment ID: {result.shipment_id || '—'}</span>
                <span className="bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 px-2 py-0.5 rounded font-bold font-mono">PO Ref No.: {result.po_ref_no || '—'}</span>
                {result.batch_id ? (
                  <span className="flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-2 py-0.5 rounded font-bold font-mono">
                    <CheckCircle2 className="h-3 w-3" /> Batch: {result.batch_id}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 bg-amber-500/10 border border-amber-500/30 text-amber-300 px-2 py-0.5 rounded font-bold">
                    <AlertCircle className="h-3 w-3" /> Batch not found — printing without batch barcode
                  </span>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[520px]">
                  <thead>
                    <tr className="border-b border-slate-800 text-[10px] uppercase font-bold text-slate-500">
                      <th className="py-2 px-3">Item SKU</th>
                      <th className="py-2 px-3">EAN / FNSKU</th>
                      <th className="py-2 px-3">Item Name</th>
                      <th className="py-2 px-3 text-right">Qty</th>
                      <th className="py-2 px-3 text-right">Pending Qty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50 text-xs">
                    {result.lines.map(l => (
                      <tr key={l.line_id} className="hover:bg-slate-800/30 transition">
                        <td className="py-2 px-3 font-mono font-bold text-indigo-300">{l.item_sku}</td>
                        <td className="py-2 px-3 font-mono text-slate-500">{l.ean_fnsku || '—'}</td>
                        <td className="py-2 px-3 text-slate-300 max-w-[280px] truncate">{l.item_name}</td>
                        <td className="py-2 px-3 text-right font-mono font-bold text-white">{l.qty}</td>
                        <td className="py-2 px-3 text-right font-mono text-slate-400">{l.pending_qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Full-screen overlay while a PDF action runs — PdfService briefly disables
              every stylesheet on the page during capture, which would otherwise flash
              the whole app unstyled. This overlay uses ONLY inline styles and an SMIL
              (not CSS) spinner animation, so it stays fully visible through that window
              — a Tailwind-classed overlay would lose its own styling at the same time. */}
          {busyAction && (
            <div style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999,
              backgroundColor: 'rgba(2, 6, 23, 0.95)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px',
            }}>
              <InlineSpinner />
              <p style={{ fontSize: '14px', fontWeight: 700, color: '#ffffff', fontFamily: 'Arial, sans-serif', margin: 0 }}>
                {busyAction === 'print' ? 'Preparing print preview…' : 'Generating PDF…'}
              </p>
            </div>
          )}

          {/* Hidden off-screen print target, captured by PdfService for both download and
              print. One .print-page-target per chunk of ROWS_PER_PAGE lines — PdfService
              turns each into its own PDF page, so overflow spills onto extra sheets
              instead of being clipped on a single fixed-height page. */}
          {result && linePages.length > 0 && (
            <div id="receiving-sheet-print-area" style={{ position: 'fixed', left: '-10000px', top: 0 }}>
              {linePages.map((pageLines, pageIndex) => (
                <div
                  key={pageIndex}
                  className="print-page-target"
                  style={{
                    width: '297mm', height: '210mm', padding: '10mm', boxSizing: 'border-box',
                    backgroundColor: '#ffffff', color: '#000000', fontFamily: 'Arial, sans-serif',
                  }}
                >
                  {/* Header: PO Ref No. barcode — title — batch barcode (if resolved).
                      Barcode blocks are NOT width-constrained — they size to their own
                      natural (unsquashed) width; the title shrinks/wraps to fit around them. */}
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '4mm',
                    borderBottom: '2px solid #000000', paddingBottom: '4mm', marginBottom: '4mm',
                  }}>
                    <div style={{ textAlign: 'center', flexShrink: 0 }}>
                      <div style={{ fontSize: '8px', fontWeight: 700, marginBottom: '1mm' }}>PO REF NO.</div>
                      {result.po_ref_no && <ReceivingSheetBarcode value={result.po_ref_no} />}
                      <div style={{ fontSize: '9px', fontWeight: 700, marginTop: '1mm' }}>{result.po_ref_no}</div>
                    </div>

                    <div style={{ textAlign: 'center', flex: '1 1 auto', minWidth: 0, paddingTop: '2mm' }}>
                      <div style={{ fontSize: '16px', fontWeight: 800 }}>Purchase Order Inbound Sheet</div>
                      <div style={{ fontSize: '9px', marginTop: '2mm' }}>
                        PO ID: {result.po_id}&nbsp;&nbsp;|&nbsp;&nbsp;Shipment ID: {result.shipment_id || '—'}
                      </div>
                    </div>

                    <div style={{ textAlign: 'center', flexShrink: 0 }}>
                      {result.batch_id && (
                        <>
                          <div style={{ fontSize: '8px', fontWeight: 700, marginBottom: '1mm' }}>BATCH</div>
                          <ReceivingSheetBarcode value={result.batch_id} />
                          <div style={{ fontSize: '9px', fontWeight: 700, marginTop: '1mm' }}>{result.batch_id}</div>
                        </>
                      )}
                    </div>
                  </div>

                  {linePages.length > 1 && (
                    <div style={{ textAlign: 'right', fontSize: '8px', marginBottom: '2mm' }}>
                      Page {pageIndex + 1} of {linePages.length}
                    </div>
                  )}

                  {/* Line items table */}
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={headerCellStyle}>PO ID</th>
                        <th style={headerCellStyle}>PO Ref No.</th>
                        <th style={headerCellStyle}>Item SKU</th>
                        <th style={headerCellStyle}>EAN / FNSKU</th>
                        <th style={headerCellStyle}>Item Name</th>
                        <th style={{ ...headerCellStyle, textAlign: 'right' }}>Qty</th>
                        <th style={headerCellStyle}>Inbound</th>
                        <th style={headerCellStyle}>Remark</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageLines.map(l => (
                        <tr key={l.line_id}>
                          <td style={cellStyle}>{l.po_id}</td>
                          <td style={cellStyle}>{l.po_ref_no}</td>
                          <td style={{ ...cellStyle, fontWeight: 700 }}>{l.item_sku}</td>
                          <td style={cellStyle}>{l.ean_fnsku || ''}</td>
                          <td style={cellStyle}>{l.item_name}</td>
                          <td style={{ ...cellStyle, textAlign: 'right', fontWeight: 700 }}>{l.qty}</td>
                          <td style={cellStyle}>&nbsp;</td>
                          <td style={cellStyle}>&nbsp;</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
