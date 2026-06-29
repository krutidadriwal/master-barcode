import { XCircle, AlertTriangle, Mail } from 'lucide-react';
import { Product } from '../types';

interface DuplicateEANModalProps {
  ean: string;
  products: Product[];
  onClose: () => void;
}

export function DuplicateEANModal({ ean, products, onClose }: DuplicateEANModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-red-500/40 rounded-2xl p-6 shadow-2xl max-w-md w-full mx-4">

        {/* Header */}
        <div className="flex items-start gap-3 mb-5">
          <div className="bg-red-500/20 p-2.5 rounded-full shrink-0">
            <AlertTriangle className="h-6 w-6 text-red-400" />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-bold text-red-300">Duplicate EAN Detected</h2>
            <p className="text-xs text-slate-400 mt-0.5">Printing has been blocked automatically</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 cursor-pointer shrink-0 transition"
          >
            <XCircle className="h-5 w-5" />
          </button>
        </div>

        {/* EAN value */}
        <div className="bg-slate-950 border border-red-500/20 rounded-xl p-4 mb-4">
          <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">EANUPC</span>
          <span className="text-xl font-mono font-bold text-red-300 tracking-wider">{ean}</span>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            This EANUPC is assigned to multiple SKUs. Printing has been blocked.
          </p>
        </div>

        {/* Affected SKUs */}
        <div className="mb-4">
          <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-2">
            Affected SKUs
          </span>
          <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
            {products.map((p, i) => (
              <div
                key={p.sku}
                className="flex items-start gap-2.5 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2"
              >
                <span className="text-xs text-slate-600 font-mono shrink-0 mt-0.5">{i + 1}.</span>
                <div className="min-w-0">
                  <span className="text-xs font-mono font-bold text-white">{p.sku}</span>
                  {p.product_name && (
                    <span className="text-[10px] text-slate-400 block truncate">{p.product_name}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Email note */}
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 mb-5 flex items-start gap-2">
          <Mail className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300 leading-relaxed">
            An escalation email will be sent to <span className="font-semibold">kruti@cubelelo.com</span> at the end of this session.
            Please resolve the product master data before printing.
          </p>
        </div>

        <button
          onClick={onClose}
          className="w-full bg-slate-800 hover:bg-slate-700 text-white font-semibold py-2.5 px-4 rounded-xl transition text-sm cursor-pointer"
        >
          Understood — Close
        </button>
      </div>
    </div>
  );
}
