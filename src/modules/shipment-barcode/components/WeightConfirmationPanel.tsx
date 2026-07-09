import { useEffect, useRef, useState } from 'react';
import { Scale, ChevronUp, ChevronDown, Plus, X, Camera, Image as ImageIcon, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';

const MAX_PHOTOS = 15;
// Vercel serverless functions cap a single request body at ~4.5MB (see the
// compression note below) — with up to 15 photos we can no longer fit them
// all in one multipart request no matter how hard we compress. Upload in
// batches instead; each batch stays comfortably under that cap.
const UPLOAD_BATCH_SIZE = 3;

interface WeightRow {
  id: string;
  listedWeight: string;
  measuredWeight: string;
}

interface WeightConfirmationPanelProps {
  shipmentId: string;
  batchId: string;
  /** Weights already saved in Supabase for this shipment from a prior confirmation, if any. */
  existingListedWeight?: number | null;
  existingActualWeight?: number | null;
  /** Fires whenever the confirmed state changes. */
  onCompletionChange?: (complete: boolean) => void;
}

// Listed weight is often not available (not every vendor provides it) — only
// the measured (physically weighed) value is required to confirm a carton.
const isRowFilled = (r: WeightRow) =>
  r.measuredWeight.trim() !== '' && parseFloat(r.measuredWeight) > 0;

// Vercel serverless functions reject request bodies over ~4.5MB outright, before
// our code (or multer's own file-size limit) ever runs — a constraint that doesn't
// exist on the local Express dev server, so it's easy to miss. Phone photos are
// routinely 3-8MB each, which would blow that budget even within a single
// UPLOAD_BATCH_SIZE-sized batch. Downscale + re-encode client-side so each
// batch comfortably fits.
const MAX_PHOTO_DIMENSION = 1600;
const PHOTO_JPEG_QUALITY = 0.75;

async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', PHOTO_JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file; // compression didn't help — keep original
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
  } catch {
    return file; // fall back to the original if decoding fails for any reason
  }
}

/**
 * Manual weight-confirmation step shown above the scanner for AIR shipments
 * only — lets warehouse staff record the listed (invoice) weight vs the
 * measured (physical) weight per carton, plus up to 3 reference photos.
 *
 * On Confirm: posts the cumulative listed/measured totals to
 * vendor_shipments.listed_weight/actual_weight, and (if photos were added)
 * uploads them to Google Drive and stores the resulting folder link in
 * vendor_shipments.drive_link. Both are Supabase-only columns — never sent
 * to or read from Apps Script.
 */
export function WeightConfirmationPanel({ shipmentId, batchId, existingListedWeight, existingActualWeight, onCompletionChange }: WeightConfirmationPanelProps) {
  const makeRow = (listedWeight = '', measuredWeight = ''): WeightRow => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    listedWeight,
    measuredWeight,
  });

  // A weight already recorded in Supabase (from a prior confirmation) is only
  // stored as a shipment-wide total, not a per-carton breakdown — so it's
  // loaded into a single row showing that total directly. Staff can just hit
  // Confirm to re-save it as-is, or edit it before confirming.
  const hasExistingWeight = (existingActualWeight ?? 0) > 0 || (existingListedWeight ?? 0) > 0;
  // Always start with a single row, even for shipments with hundreds of
  // cartons — pre-generating one row per carton (via cartonCount) made the
  // panel unusable at scale. Staff add rows manually via "Add Carton" only
  // for the cartons they actually want to record separately.
  const [rows, setRows] = useState<WeightRow[]>(() => [makeRow(
    existingListedWeight ? String(existingListedWeight) : '',
    existingActualWeight ? String(existingActualWeight) : ''
  )]);
  const [expanded, setExpanded] = useState(true);
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [compressingPhotos, setCompressingPhotos] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allWeighed = rows.length > 0 && rows.every(isRowFilled);

  // existingListedWeight/existingActualWeight arrive from an async batch-detail
  // fetch in the parent, which typically resolves *after* this panel has
  // already mounted (and its useState initializer above has already run with
  // nothing to prefill). Back-fill once the real values show up — but only
  // while every row is still untouched, so we never clobber user input.
  useEffect(() => {
    if (!hasExistingWeight) return;
    setRows(prev => {
      const pristine = prev.every(r => r.listedWeight === '' && r.measuredWeight === '');
      if (!pristine) return prev;
      return [makeRow(
        existingListedWeight ? String(existingListedWeight) : '',
        existingActualWeight ? String(existingActualWeight) : ''
      )];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingListedWeight, existingActualWeight, hasExistingWeight]);

  useEffect(() => {
    const urls = images.map(f => URL.createObjectURL(f));
    setPreviews(urls);
    return () => { urls.forEach(u => URL.revokeObjectURL(u)); };
  }, [images]);

  useEffect(() => {
    onCompletionChange?.(confirmed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed]);

  // Editing anything after confirming invalidates the confirmation — must re-confirm.
  const updateRow = (id: string, field: 'listedWeight' | 'measuredWeight', value: string) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, [field]: value } : r)));
    setConfirmed(false);
    setConfirmError(null);
  };

  const addRow = () => { setRows(prev => [...prev, makeRow()]); setConfirmed(false); setConfirmError(null); };
  const removeRow = (id: string) => {
    setRows(prev => (prev.length > 1 ? prev.filter(r => r.id !== id) : prev));
    setConfirmed(false);
    setConfirmError(null);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const incoming = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, MAX_PHOTOS);
    if (!incoming.length) return;
    setCompressingPhotos(true);
    try {
      const compressed = await Promise.all(incoming.map(compressImage));
      setImages(prev => [...prev, ...compressed].slice(0, MAX_PHOTOS));
      setConfirmed(false);
      setConfirmError(null);
    } finally {
      setCompressingPhotos(false);
    }
  };
  const removeImage = (idx: number) => {
    setImages(prev => prev.filter((_, i) => i !== idx));
    setConfirmed(false);
    setConfirmError(null);
  };

  const totalListed = rows.reduce((sum, r) => sum + (parseFloat(r.listedWeight) || 0), 0);
  const totalMeasured = rows.reduce((sum, r) => sum + (parseFloat(r.measuredWeight) || 0), 0);
  const diff = totalMeasured - totalListed;
  const hasAnyWeight = totalListed > 0 || totalMeasured > 0;

  const handleConfirm = async () => {
    if (!allWeighed || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const weightsRes = await fetch('/api/shipment/confirm-weights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipment_id: shipmentId, listed_weight: totalListed, actual_weight: totalMeasured }),
      });
      const weightsData = await weightsRes.json().catch(() => ({}));
      if (!weightsRes.ok) throw new Error(weightsData.error || `HTTP ${weightsRes.status}`);

      // Upload in batches of UPLOAD_BATCH_SIZE — a single request with all 15
      // photos could exceed Vercel's ~4.5MB body cap; each batch stays under it.
      // All batches land in the same Drive folder (per-shipment, keyed by
      // batch_id + shipment_id), so this is safe to repeat sequentially.
      for (let i = 0; i < images.length; i += UPLOAD_BATCH_SIZE) {
        const batch = images.slice(i, i + UPLOAD_BATCH_SIZE);
        const form = new FormData();
        form.set('shipment_id', shipmentId);
        form.set('batch_id', batchId);
        batch.forEach(img => form.append('photos', img));
        const photosRes = await fetch('/api/shipment/upload-weight-photos', { method: 'POST', body: form });
        const photosData = await photosRes.json().catch(() => ({}));
        if (!photosRes.ok) throw new Error(photosData.error || `HTTP ${photosRes.status}`);
      }

      setConfirmed(true);
    } catch (err: any) {
      setConfirmError(err.message || 'Failed to save weight confirmation.');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-amber-500/30 rounded-2xl shadow-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/40 transition cursor-pointer select-none"
      >
        <div className="flex items-center gap-2">
          <Scale className="h-3.5 w-3.5 text-amber-400" />
          <h2 className="text-xs font-bold text-slate-100 uppercase tracking-wider">Weight Confirmation</h2>
          <span className="text-[9px] uppercase bg-amber-500/10 border border-amber-500/30 text-amber-400 px-2 py-0.5 rounded font-bold tracking-wider">
            Air Shipment
          </span>
          {confirmed ? (
            <span className="text-[9px] uppercase bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-2 py-0.5 rounded font-bold tracking-wider">
              Confirmed
            </span>
          ) : allWeighed ? (
            <span className="text-[9px] uppercase bg-amber-500/10 border border-amber-500/30 text-amber-400 px-2 py-0.5 rounded font-bold tracking-wider">
              Ready to confirm
            </span>
          ) : (
            <span className="text-[9px] uppercase bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-0.5 rounded font-bold tracking-wider">
              Incomplete — scanning locked
            </span>
          )}
          {hasExistingWeight && (
            <span className="text-[9px] font-mono text-sky-400">
              (saved: {existingListedWeight ? existingListedWeight.toFixed(2) : '—'} / {existingActualWeight ? existingActualWeight.toFixed(2) : '—'} kg)
            </span>
          )}
        </div>
        {expanded ? <ChevronUp className="h-3.5 w-3.5 text-slate-500" /> : <ChevronDown className="h-3.5 w-3.5 text-slate-500" />}
      </button>

      {expanded && (
        <div className="border-t border-slate-800 p-4 space-y-4">
          {hasExistingWeight && (
            <div className="flex items-center gap-2 bg-sky-500/10 border border-sky-500/30 rounded-lg px-3 py-2 text-[11px] text-sky-300">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>
                Previously recorded: Listed{' '}
                <strong className="font-mono">{existingListedWeight ? existingListedWeight.toFixed(2) : '—'} kg</strong>
                {' '}/ Measured{' '}
                <strong className="font-mono">{existingActualWeight ? existingActualWeight.toFixed(2) : '—'} kg</strong>
                {' '}— loaded below, edit if needed or just confirm to proceed.
              </span>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[420px]">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] uppercase font-bold text-slate-500">
                  <th className="py-2 px-3">Carton #</th>
                  <th className="py-2 px-3">Listed Weight (kg)</th>
                  <th className="py-2 px-3">Measured Weight (kg)</th>
                  <th className="py-2 px-3 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50 text-xs">
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    <td className="py-1.5 px-3 font-mono text-slate-400">#{i + 1}</td>
                    <td className="py-1.5 px-3">
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        value={r.listedWeight}
                        onChange={e => updateRow(r.id, 'listedWeight', e.target.value)}
                        placeholder="0.00"
                        className="w-24 bg-slate-950 border border-slate-700 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 rounded-lg px-2 py-1 text-xs text-white font-mono transition"
                      />
                    </td>
                    <td className="py-1.5 px-3">
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        value={r.measuredWeight}
                        onChange={e => updateRow(r.id, 'measuredWeight', e.target.value)}
                        placeholder="0.00"
                        className="w-24 bg-slate-950 border border-slate-700 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 rounded-lg px-2 py-1 text-xs text-white font-mono transition"
                      />
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(r.id)}
                        disabled={rows.length === 1}
                        className="text-slate-500 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition"
                        title="Remove carton"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 1 && (
                <tfoot>
                  <tr className="border-t border-slate-800 text-xs font-bold">
                    <td className="py-2 px-3 text-slate-400">Total</td>
                    <td className="py-2 px-3 font-mono text-white">{totalListed.toFixed(2)}</td>
                    <td className="py-2 px-3 font-mono text-white">{totalMeasured.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="flex items-center justify-between">
            <button
              type="button" onClick={addRow}
              className="flex items-center gap-1.5 text-[11px] font-bold text-amber-400 hover:text-amber-300 cursor-pointer transition"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Carton
            </button>
            {hasAnyWeight && Math.abs(diff) > 0.001 && (
              <span className={`text-[10px] font-bold ${diff > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                Diff: {diff > 0 ? '+' : ''}{diff.toFixed(2)} kg
              </span>
            )}
          </div>

          <div className="border-t border-slate-800 pt-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] font-bold text-slate-300 uppercase tracking-wider">Photos ({images.length}/{MAX_PHOTOS})</h3>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={images.length >= MAX_PHOTOS || compressingPhotos}
                className="flex items-center gap-1.5 text-[10px] font-bold text-slate-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed bg-slate-800 hover:bg-slate-700 border border-slate-700 px-2.5 py-1 rounded-lg cursor-pointer transition"
              >
                {compressingPhotos ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
                {compressingPhotos ? 'Processing…' : 'Add Photo'}
              </button>
              <input
                ref={fileInputRef}
                type="file" accept="image/*" multiple
                className="hidden"
                onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
              />
            </div>

            {images.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-slate-500 text-[11px] gap-1.5 border border-dashed border-slate-700 rounded-xl">
                <ImageIcon className="h-5 w-5 text-slate-700" />
                <span>No photos added yet.</span>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {previews.map((src, i) => (
                  <div key={i} className="relative rounded-lg overflow-hidden border border-slate-700 aspect-square bg-slate-950">
                    <img src={src} alt={`Weight confirmation photo ${i + 1}`} className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeImage(i)}
                      className="absolute top-1 right-1 bg-black/60 hover:bg-red-600 text-white rounded-full p-1 cursor-pointer transition"
                      title="Remove photo"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[9px] text-slate-600 mt-2">Photos are uploaded to a shared Drive folder for this shipment on confirmation.</p>
          </div>

          {confirmError && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-[11px] text-red-300">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {confirmError}
            </div>
          )}

          <div className="border-t border-slate-800 pt-3 flex items-center justify-end gap-2">
            {confirmed && (
              <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Weights confirmed — scanning unlocked
              </span>
            )}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!allWeighed || confirmed || confirming}
              className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-[11px] font-bold uppercase tracking-wider py-2 px-4 rounded-lg transition cursor-pointer select-none"
            >
              {confirming ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {confirming ? 'Saving…' : confirmed ? 'Confirmed' : 'Confirm Weights'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
