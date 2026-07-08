import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, FileDown, Printer, Search, RefreshCw, AlertCircle, PackageSearch, CheckCircle2, XCircle } from 'lucide-react';
import { downloadReceivingSheetPdf, printReceivingSheetPdf, type ReceivingSheetLine } from '../services/ReceivingSheetPdfBuilder';

const APP_SCRIPT_FOR_BARCODE = import.meta.env.VITE_APP_SCRIPT_FOR_BARCODE === 'true';

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
  // Which PDF action is currently running — drives the buttons' disabled/spinner state.
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

  const handleDownload = async () => {
    if (!result?.lines.length) return;
    setBusyAction('download');
    setError(null);
    try {
      const filename = `Receiving_Sheet_${result.po_ref_no || result.po_id}`;
      await downloadReceivingSheetPdf(result, filename);
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
      await printReceivingSheetPdf(result);
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
                      <th className="py-2 px-3 text-right">#</th>
                      <th className="py-2 px-3">Item SKU</th>
                      <th className="py-2 px-3">EAN / FNSKU</th>
                      <th className="py-2 px-3">Item Name</th>
                      <th className="py-2 px-3 text-right">Qty</th>
                      <th className="py-2 px-3 text-right">Pending Qty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50 text-xs">
                    {result.lines.map((l, i) => (
                      <tr key={l.line_id} className="hover:bg-slate-800/30 transition">
                        <td className="py-2 px-3 text-right font-mono text-slate-500">{i + 1}</td>
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

        </>
      )}
    </div>
  );
}
