import { useState, useEffect, useRef } from 'react';
import { Search, Printer, History, RefreshCw, CheckCircle2, AlertCircle, Database, Sparkles, BookOpen, FileDown } from 'lucide-react';
import { Product, BarcodeCache } from '../../../shared/types';
import { SingleBarcodeValidator } from '../validators';
import { SINGLE_BARCODE_CONFIG } from '../config';
import { BarcodeApi } from '../api/barcodeApi';
import { BarcodePreview } from './BarcodePreview';
import { PrintableLabelContainer } from './PrintableLabelContainer';
import { generateSingleBarcodeBatchNo } from '../../../shared/utilities/batchNo';
import { downloadLabelsPdf } from '../../../shared/utilities/pdfExport';

const PDF_ENABLE = import.meta.env.VITE_PDF_ENABLE === 'true';
import { BarcodeGeneratorService } from '../../../shared/services/BarcodeGeneratorService';

export function SingleBarcodeForm() {
  const [identifier, setIdentifier] = useState<string>('');
  const [quantity, setQuantity] = useState<number>(1);
  const [product, setProduct] = useState<Product | null>(null);
  
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  
  // Storage state of the last generation for the reprint feature
  const [cachedGen, setCachedGen] = useState<BarcodeCache | null>(null);
  
  // Custom dialogs & dropdown toggles
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [showCatalog, setShowCatalog] = useState<boolean>(false);
  // Track manual search to bypass automatic debouncing during button clicks
  const isSelectedOrManualAction = useRef<boolean>(false);

  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const [isPdfExporting, setIsPdfExporting] = useState<boolean>(false);

  // Load reprint cache and initial database companion catalogs
  useEffect(() => {
    loadCachedGeneration();
    refreshCatalogList();
  }, []);

  const loadCachedGeneration = () => {
    try {
      const cached = localStorage.getItem(SINGLE_BARCODE_CONFIG.storageKeys.lastGeneration);
      if (cached) {
        setCachedGen(JSON.parse(cached));
      }
    } catch (err) {
      console.warn('Failed to load reprint cache state:', err);
    }
  };

  const refreshCatalogList = async () => {
    try {
      const list = await BarcodeApi.fetchAllProducts();
      setCatalog(list);
    } catch (err) {
      console.warn('Catalog cheat-sheet could not be loaded:', err);
    }
  };

  // Automatic search debounce listener
  useEffect(() => {
    const cleanId = identifier.trim();
    if (!cleanId) {
      setProduct(null);
      setError(null);
      return;
    }

    // If search was resolved manually or auto-selected from list, skip debouncing
    if (isSelectedOrManualAction.current) {
      isSelectedOrManualAction.current = false;
      return;
    }

    const validatorRes = SingleBarcodeValidator.validateIdentifier(cleanId);
    if (!validatorRes.isValid) {
      // Show soft validation warning
      setError(validatorRes.error || null);
      setProduct(null);
      return;
    }

    setError(null);
    const delayDebounceFn = setTimeout(() => {
      executeSearch(cleanId);
    }, 450); // 450ms wait ensures friendly typing speeds before querying BFF

    return () => clearTimeout(delayDebounceFn);
  }, [identifier]);

  // Execute actual BFF product retrieval
  const executeSearch = async (queryId: string) => {
    if (!queryId.trim()) return;
    
    setLoading(true);
    setError(null);
    try {
      const foundProduct = await BarcodeApi.searchProduct(queryId);

      setProduct(foundProduct);

      // Save this generation to reprint cache automatically
      saveGenerationToCache(foundProduct, queryId, quantity);
    } catch (err: any) {
      setProduct(null);
      setError(err.message || 'Product lookup failed.');
    } finally {
      setLoading(false);
    }
  };

  const saveGenerationToCache = (prod: Product, ident: string, qty: number) => {
    try {
      const cacheObj: BarcodeCache = {
        identifier: ident,
        product: prod,
        quantity: qty
      };
      localStorage.setItem(SINGLE_BARCODE_CONFIG.storageKeys.lastGeneration, JSON.stringify(cacheObj));
      setCachedGen(cacheObj); // trigger UI update
    } catch (err) {
      console.warn('Failed to commit cache storage:', err);
    }
  };

  // Keep print quantity in sync inside cache when changed
  const handleQuantityChange = (val: number) => {
    setQuantity(val);
    if (product) {
      saveGenerationToCache(product, identifier, val);
    }
  };

  // Immediate database-free Reprint Action
  const triggerReprintRestore = () => {
    if (!cachedGen) return;
    
    isSelectedOrManualAction.current = true;
    setIdentifier(cachedGen.identifier);
    setProduct(cachedGen.product);
    setQuantity(cachedGen.quantity);
    setError(null);
  };

  const handlePrint = () => {
    if (!product) return;
    const barcodeValue = (product.EANUPC && product.EANUPC.trim() !== '')
      ? product.EANUPC.trim()
      : (product.sku && product.sku.trim() !== '' ? product.sku.trim() : '');
    
    if (!barcodeValue) {
      setError('A barcode or SKU value is required to print a label.');
      return;
    }
    
    // Trigger native printing instantly
    setTimeout(() => {
      window.print();
    }, 50);
  };

  const handleDownloadPdf = async () => {
    if (!product || isPdfExporting || !pdfContainerRef.current) return;
    setIsPdfExporting(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
      await downloadLabelsPdf(pdfContainerRef.current, `Barcode_${product.sku}_${date}.pdf`);
    } catch (err) {
      console.error('[PDF Export] Failed:', err);
    } finally {
      setIsPdfExporting(false);
    }
  };

  // Quick select items from auxiliary list
  const selectCatalogProduct = (p: Product) => {
    isSelectedOrManualAction.current = true;
    setIdentifier(p.sku || p.EANUPC || '');
    setProduct(p);
    setError(null);
    setShowCatalog(false);
    saveGenerationToCache(p, p.sku || p.EANUPC || '', quantity);
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      
      {/* Search Bar & Primary Actions Panel */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 border-b border-slate-800/60 pb-4">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-indigo-400" />
              Dynamic Single Barcode Engine
            </h1>
            <p className="text-slate-400 text-xs">Type, scan, or pick product SKU to generate scannable labels instantly</p>
          </div>

          {/* Quick buttons */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Reprint Last Barcode */}
            {cachedGen && (
              <button
                onClick={triggerReprintRestore}
                className="flex items-center gap-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 hover:text-indigo-300 border border-indigo-500/20 px-3.5 py-1.5 rounded-xl text-xs font-semibold tracking-wide transition cursor-pointer"
                title={`Last label: ${cachedGen.product.product_name}`}
              >
                <History className="h-4 w-4" />
                Reprint Last Barcode ({cachedGen.product.sku})
              </button>
            )}

            {/* Quick Catalog list dropdown toggle */}
            <button
              onClick={() => {
                setShowCatalog(!showCatalog);
                refreshCatalogList();
              }}
              className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-3.5 py-1.5 rounded-xl text-xs font-semibold tracking-wide transition cursor-pointer"
            >
              <Database className="h-4 w-4" />
              Database Cheat-sheet
            </button>

          </div>
        </div>

        {/* Database Quick select display */}
        {showCatalog && (
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80 animate-fadeIn space-y-3">
            <div className="flex justify-between items-center pb-2 border-b border-slate-900">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                <BookOpen className="h-3.5 w-3.5 text-indigo-400" />
                Database Seed List (Click to search auto-fill)
              </span>
              <button 
                onClick={() => setShowCatalog(false)}
                className="text-slate-500 hover:text-slate-300 text-xs font-semibold"
              >
                Close list
              </button>
            </div>
            {catalog.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">Catalog empty. Use 'Sync Product Master' to populate products from EasyEcom.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 py-1 max-h-52 overflow-y-auto pr-1">
                {catalog.map((p) => {
                  const resolvedVal = (p.EANUPC && p.EANUPC.trim() !== '') ? p.EANUPC.trim() : (p.sku && p.sku.trim() !== '' ? p.sku.trim() : '');
                  const formatType = BarcodeGeneratorService.detectFormat(resolvedVal);
                  return (
                    <div
                      key={p.product_id}
                      onClick={() => selectCatalogProduct(p)}
                      className="p-2.5 rounded-lg border border-slate-900 bg-slate-900/50 hover:bg-slate-850 hover:border-slate-700 cursor-pointer text-left transition duration-200 group flex flex-col justify-between"
                    >
                      <div className="text-xs font-bold text-slate-200 group-hover:text-indigo-400 truncate mb-0.5">{p.product_name}</div>
                      <div className="flex justify-between items-center text-[10px] text-slate-500 font-mono mt-1">
                        <span>SKU: {p.sku}</span>
                        <span className="bg-slate-950 text-indigo-400 px-1 rounded border border-slate-800 text-[8px]">{formatType}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Search Inputs Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          {/* Paste Identifier */}
          <div className="md:col-span-3 space-y-2">
            <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block">
              Identifier (EAN, UPC, or SKU)
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                <Search className="h-4 w-4 text-slate-500" />
              </div>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="Paste SKU, EAN-13, or UPC code (e.g. 990011, 123456, 8901234567890)"
                className="w-full bg-slate-950 border border-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-xl pl-10 pr-4 py-3 text-sm text-white placeholder-slate-500 tracking-wide font-medium transition"
              />
              
              {/* Reset input button */}
              {identifier && (
                <button
                  onClick={() => {
                    setIdentifier('');
                    setProduct(null);
                    setError(null);
                  }}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-500 hover:text-slate-350 text-xs font-semibold cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Quantity Support */}
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-300 uppercase tracking-wider block">
              Print Quantity
            </label>
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-2">
              <button
                type="button"
                onClick={() => handleQuantityChange(Math.max(1, quantity - 1))}
                className="text-slate-400 hover:text-white p-2.5 hover:bg-slate-900 rounded-lg text-md font-bold transition cursor-pointer"
              >
                -
              </button>
              <input
                type="number"
                min="1"
                max={SINGLE_BARCODE_CONFIG.limits.maxQuantity}
                value={quantity === 0 ? '' : quantity}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 0;
                  handleQuantityChange(Math.min(SINGLE_BARCODE_CONFIG.limits.maxQuantity, val));
                }}
                className="w-full bg-transparent text-center text-sm font-semibold text-white focus:outline-none focus:ring-0 py-3 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button
                type="button"
                onClick={() => handleQuantityChange(Math.min(SINGLE_BARCODE_CONFIG.limits.maxQuantity, quantity + 1))}
                className="text-slate-400 hover:text-white p-2.5 hover:bg-slate-900 rounded-lg text-md font-bold transition cursor-pointer"
              >
                +
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Results Board */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* Left Side: Status display & details card */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <h2 className="text-md font-bold text-slate-200 flex items-center gap-2 pb-3 border-b border-slate-800/60">
            Product Status Info
          </h2>

          <div className="min-h-48 flex flex-col justify-center">
            {loading ? (
              <div className="flex flex-col items-center justify-center space-y-4 py-8">
                <RefreshCw className="h-8 w-8 text-indigo-500 animate-spin" />
                <p className="text-xs text-indigo-400 font-semibold tracking-wider animate-pulse">Querying database repository...</p>
              </div>
            ) : error ? (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl flex items-start gap-3">
                <AlertCircle className="h-5 w-5 shrink-0 text-red-500 mt-0.5" />
                <div className="space-y-1 text-left">
                  <h4 className="text-sm font-bold text-red-300">Identifier Lookup Error</h4>
                  <p className="text-xs leading-relaxed text-red-400/90">{error}</p>
                </div>
              </div>
            ) : product ? (
              /* Product metadata checklist */
              <div className="space-y-4 text-left">
                <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-2 rounded-xl text-xs font-semibold">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  Product Synced Successfully
                </div>

                <div className="space-y-3">
                  <div>
                    <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block">Item Name</span>
                    <span className="text-sm font-bold text-white block mt-0.5 leading-snug">{product.product_name}</span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 pt-1">
                    <div>
                      <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block">SKU Code</span>
                      <span className="text-sm font-mono font-bold text-white block mt-0.5">{product.sku}</span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block">EAN/UPC Code</span>
                      <span className="text-sm font-mono font-semibold text-white block mt-0.5">{product.EANUPC || '-'}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-1">
                    <div>
                      <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block">MRP Value</span>
                      <span className="text-sm font-bold text-indigo-400 block mt-0.5">{product.mrp}</span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block">Auto Barcode Target</span>
                      <span className="text-xs bg-slate-950 font-bold text-indigo-400 border border-slate-800 px-2.5 py-1 rounded-md inline-block mt-1 uppercase tracking-wider font-mono">
                        {BarcodeGeneratorService.detectFormat(
                          (product.EANUPC && product.EANUPC.trim() !== '') ? product.EANUPC.trim() : (product.sku && product.sku.trim() !== '' ? product.sku.trim() : '')
                        )}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Print launch action */}
                <button
                  onClick={handlePrint}
                  className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-550 text-white font-semibold py-3 px-4 rounded-xl transition duration-150 animate-glow hover:shadow-indigo-550/30 text-sm mt-4 cursor-pointer"
                >
                  <Printer className="h-4.5 w-4.5" />
                  Print Label
                </button>

                {/* PDF download action */}
                {PDF_ENABLE && (
                  <button
                    type="button"
                    onClick={handleDownloadPdf}
                    disabled={isPdfExporting}
                    className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 hover:text-white font-semibold py-3 px-4 rounded-xl transition duration-150 text-sm mt-2 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {isPdfExporting ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        Generating PDF...
                      </>
                    ) : (
                      <>
                        <FileDown className="h-4 w-4" />
                        Download PDF
                      </>
                    )}
                  </button>
                )}
              </div>
            ) : (
              /* Awaiting state */
              <div className="text-center py-8 text-slate-500 space-y-2">
                <div className="inline-block bg-slate-950 border border-slate-800 p-4 rounded-full text-slate-600">
                  <Search className="h-7 w-7" />
                </div>
                <p className="text-sm font-medium">Awaiting Input Scan...</p>
                <p className="text-xs text-slate-600 max-w-xs mx-auto">Input identifier, copy-paste SKU values, or pick an item from our Database Cheat-sheet list to display labels.</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Virtual Thermal Label Preview */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex justify-between items-center pb-3 border-b border-slate-800/60">
            <h2 className="text-md font-bold text-slate-200">
              Label Core Preview (50mm × 30mm)
            </h2>
            {product && (
              <span className="text-xs font-semibold bg-indigo-500/10 border border-indigo-500/25 text-indigo-400 py-1 px-2.5 rounded-lg">
                Shows 1 of {quantity} labels
              </span>
            )}
          </div>

          <div className="bg-slate-950 border border-slate-800/60 rounded-xl p-8 flex items-center justify-center min-h-48 overflow-auto">
            {product ? (
              <div className="hover:ring-2 hover:ring-indigo-500 p-2 bg-white rounded-md transition shadow-2xl">
                {/* Visual rendering representation scaled appropriately */}
                <BarcodePreview product={product} scale={1.5} batchNo={generateSingleBarcodeBatchNo()} />
              </div>
            ) : (
              <div className="text-center text-slate-600 text-xs max-w-xs leading-relaxed py-6">
                Label rendering will appear here as soon as a registered product matches.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* PDF CAPTURE: Off-screen container for html2canvas — visible but outside viewport */}
      {PDF_ENABLE && product && (
        <div
          ref={pdfContainerRef}
          style={{ position: 'fixed', left: '-9999px', top: 0, background: '#fff', pointerEvents: 'none' }}
          aria-hidden="true"
        >
          {Array.from({ length: quantity || 1 }).map((_, i) => (
            <div key={i} className="print-label-item" style={{ width: '50mm', height: '30mm' }}>
              <BarcodePreview product={product} scale={1.0} batchNo={generateSingleBarcodeBatchNo()} />
            </div>
          ))}
        </div>
      )}

      {/* PRINT ENGINE: NATIVE PRINT PORTAL CONTAINER */}
      {product && (
        <PrintableLabelContainer
          product={product}
          quantity={quantity}
          batchNo={generateSingleBarcodeBatchNo()}
        />
      )}

    </div>
  );
}
