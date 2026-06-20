import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ZoomIn, ZoomOut, Printer, FileDown, Layers, ChevronLeft, ChevronRight, X, AlertTriangle, Monitor } from 'lucide-react';
import { Product } from '../../../shared/types';
import { BarcodePreview } from './BarcodePreview';
import { PrintService } from '../../../shared/services/PrintService';
import { PdfService } from '../../../shared/services/PdfService';

interface PrintPreviewDialogProps {
  product: Product;
  quantity: number;
  onClose: () => void;
}

export function PrintPreviewDialog({ product, quantity, onClose }: PrintPreviewDialogProps) {
  // Print Mode Options:
  // - 'thermal': continuous layout, each label is 50mm x 25mm.
  // - 'a4_sheet': A4 paper (210mm x 297mm) containing multiple 50x25mm labels.
  const [printMode, setPrintMode] = useState<'thermal' | 'a4_sheet'>('thermal');
  const [zoom, setZoom] = useState<number>(1.0);
  const [currentPage, setCurrentPage] = useState<number>(0);

  // A4 sheet customization
  const [cols, setCols] = useState<number>(3);
  const [rows, setRows] = useState<number>(10);
  const [marginMm, setMarginMm] = useState<number>(15);
  const [gapMm, setGapMm] = useState<number>(4);

  const [isExporting, setIsExporting] = useState<boolean>(false);

  // Maximum labels showing on interactive page grid per panel to keep DOM ultra-light
  const PREVIEW_LIMIT = 100;

  // Let's divide labels into pages
  const totalLabels = quantity;
  const labelsPerPage = printMode === 'thermal' ? 1 : cols * rows;
  const totalPages = Math.ceil(totalLabels / labelsPerPage);

  // Prevent index out of bounds on mode changes
  const activePage = Math.min(currentPage, Math.max(0, totalPages - 1));

  // Determine label list for current page
  const labelsForActivePage = useMemo(() => {
    const startIndex = activePage * labelsPerPage;
    const count = Math.min(labelsPerPage, totalLabels - startIndex);
    return Array.from({ length: count });
  }, [activePage, labelsPerPage, totalLabels]);

  // Handle PDF Export
  const handlePdfExport = async () => {
    setIsExporting(true);
    try {
      const filename = `${product.sku || 'barcode'}_labels`;
      
      if (printMode === 'thermal') {
        await PdfService.exportToPdf('print-only-area', {
          filename,
          widthMm: 50,
          heightMm: 25,
          dpi: 300
        });
      } else {
        // A4 Paper format
        await PdfService.exportToPdf('print-only-area', {
          filename,
          widthMm: 210,
          heightMm: 297,
          dpi: 300
        });
      }
    } catch (err: any) {
      alert(`Failed to generate PDF document: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handlePrint = () => {
    PrintService.print();
  };

  const increaseZoom = () => setZoom(z => Math.min(z + 0.15, 2.0));
  const decreaseZoom = () => setZoom(z => Math.max(z - 0.15, 0.3));

  // Unified print and export portal content
  const printPortalContent = useMemo(() => {
    if (printMode === 'thermal') {
      return (
        <div id="print-only-area">
          {Array.from({ length: totalLabels }).map((_, i) => (
            <div 
              key={i} 
              className="print-page-target print-mode-roll"
              style={{
                width: '50mm',
                height: '25mm',
                boxSizing: 'border-box',
                backgroundColor: '#ffffff'
              }}
            >
              <BarcodePreview product={product} scale={1.0} />
            </div>
          ))}
        </div>
      );
    } else {
      // a4_sheet mode
      return (
        <div id="print-only-area">
          {Array.from({ length: totalPages }).map((_, pageIndex) => {
            const startIndex = pageIndex * labelsPerPage;
            const count = Math.min(labelsPerPage, totalLabels - startIndex);
            const pageLabels = Array.from({ length: count });

            return (
              <div 
                key={pageIndex} 
                className="print-page-target print-mode-a4-page text-black select-none"
                style={{
                  width: '210mm',
                  height: '297mm',
                  padding: `${marginMm}mm`,
                  boxSizing: 'border-box',
                  backgroundColor: '#ffffff'
                }}
              >
                <div 
                  className="grid h-full w-full justify-start items-start"
                  style={{
                    gridTemplateColumns: `repeat(${cols}, 50mm)`,
                    gridTemplateRows: `repeat(${rows}, 25mm)`,
                    gap: `${gapMm}mm`,
                  }}
                >
                  {pageLabels.map((_, i) => (
                    <div 
                      key={i} 
                      className="w-[50mm] h-[25mm] overflow-hidden" 
                      style={{ width: '50mm', height: '25mm', boxSizing: 'border-box' }}
                    >
                      <BarcodePreview product={product} scale={1.0} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      );
    }
  }, [printMode, totalLabels, totalPages, labelsPerPage, product, marginMm, cols, rows, gapMm]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      {/* Container Dialog Card */}
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-6xl h-[90vh] flex flex-col shadow-2xl text-slate-100 overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="bg-amber-500/10 p-2 rounded-lg border border-amber-500/30">
              <Layers className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white tracking-wide">Interactive Print Preview</h2>
              <p className="text-xs text-slate-400">Configure layout for thermal roll feed or laser label sheets</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Workspace Body */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Left panel: Control Configurations */}
          <div className="w-80 border-r border-slate-800 bg-slate-950 p-5 flex flex-col justify-between overflow-y-auto">
            <div className="space-y-6">
              {/* Layout Profile */}
              <div>
                <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-2">Print Layout Mode</h3>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      setPrintMode('thermal');
                      setCurrentPage(0);
                    }}
                    className={`p-3 rounded-xl border text-left transition flex flex-col justify-between h-20 ${
                      printMode === 'thermal' 
                        ? 'border-indigo-500 bg-indigo-500/10 text-white' 
                        : 'border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <span className="text-xs font-semibold">Continuous Roll</span>
                    <span className="text-[10px] text-slate-400">1-up Thermal Label (50x25mm)</span>
                  </button>
                  <button
                    onClick={() => {
                      setPrintMode('a4_sheet');
                      setCurrentPage(0);
                    }}
                    className={`p-3 rounded-xl border text-left transition flex flex-col justify-between h-20 ${
                      printMode === 'a4_sheet' 
                        ? 'border-indigo-500 bg-indigo-500/10 text-white' 
                        : 'border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <span className="text-xs font-semibold">A4 Sheet Grid</span>
                    <span className="text-[10px] text-slate-400">{cols * rows} labels/page (210x297mm)</span>
                  </button>
                </div>
              </div>

              {/* Layout Metrics (only for A4) */}
              {printMode === 'a4_sheet' && (
                <div className="space-y-3 bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                  <h4 className="text-xs font-bold uppercase text-indigo-400 tracking-wider">A4 Grid Specifications</h4>
                  
                  <div>
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>Columns: {cols}</span>
                      <span>(50mm width each)</span>
                    </div>
                    <input 
                      type="range" min="1" max="4" value={cols}
                      onChange={(e) => setCols(parseInt(e.target.value))}
                      className="w-full accent-indigo-500"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>Rows: {rows}</span>
                      <span>(25mm height each)</span>
                    </div>
                    <input 
                      type="range" min="1" max="11" value={rows}
                      onChange={(e) => setRows(parseInt(e.target.value))}
                      className="w-full accent-indigo-500"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-400 font-semibold mb-1 block">Margin (mm)</label>
                      <input 
                        type="number" min="5" max="30" value={marginMm}
                        onChange={(e) => setMarginMm(Math.max(5, parseInt(e.target.value) || 0))}
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400 font-semibold mb-1 block">Label Gap (mm)</label>
                      <input 
                        type="number" min="0" max="15" value={gapMm}
                        onChange={(e) => setGapMm(Math.max(0, parseInt(e.target.value) || 0))}
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* View/Page details */}
              <div className="bg-slate-900/30 p-3 rounded-lg border border-slate-800 text-xs space-y-2 text-slate-400">
                <div className="flex justify-between">
                  <span>Target SKU:</span>
                  <span className="font-mono text-white font-medium">{product.sku}</span>
                </div>
                <div className="flex justify-between">
                  <span>Batch Quantity:</span>
                  <span className="text-white font-medium">{quantity} labels</span>
                </div>
                <div className="flex justify-between">
                  <span>Required Pages:</span>
                  <span className="text-white font-medium">{totalPages} pages</span>
                </div>
              </div>

              {/* Virtualization Caution for high limits */}
              {totalLabels > PREVIEW_LIMIT && (
                <div className="flex gap-2 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-lg p-3 text-xs leading-relaxed">
                  <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">Performance Optimization:</span> Screen preview displays first {PREVIEW_LIMIT} labels to safeguard computer speed, but 100% of the {totalLabels} configured sheets will generate perfectly inside the physical print or high-res PDF.
                  </div>
                </div>
              )}
            </div>

            {/* Actions Panel */}
            <div className="pt-4 border-t border-slate-800 space-y-2">
              <button
                onClick={handlePrint}
                className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold py-2.5 px-4 rounded-xl shadow-lg transition active:scale-95 text-sm cursor-pointer"
              >
                <Printer className="h-4 w-4" />
                Print Labels
              </button>
              
              <button
                onClick={handlePdfExport}
                disabled={isExporting}
                className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-semibold py-2.5 px-4 rounded-xl transition text-sm cursor-pointer"
              >
                {isExporting ? (
                  <>
                    <span className="animate-spin inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full"></span>
                    Rendering Vector PDF...
                  </>
                ) : (
                  <>
                    <FileDown className="h-4 w-4" />
                    Export PDF
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Right panel: Print Preview Area */}
          <div className="flex-1 bg-slate-950 flex flex-col overflow-hidden relative">
            
            {/* Toolbar */}
            <div className="flex justify-between items-center p-3 border-b border-slate-800 bg-slate-900/40">
              {/* Pagination controls */}
              <div className="flex items-center gap-2">
                <button
                  disabled={activePage === 0}
                  onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                  className="bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 p-1.5 rounded-lg text-slate-300 transition"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs text-slate-300 font-medium">
                  Page <span className="text-white font-bold">{totalPages === 0 ? 0 : activePage + 1}</span> of <span className="font-bold">{totalPages}</span>
                </span>
                <button
                  disabled={activePage >= totalPages - 1}
                  onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                  className="bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-800 p-1.5 rounded-lg text-slate-300 transition"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              {/* Mode indicator */}
              <div className="flex items-center gap-1.5 bg-slate-950 px-2.5 py-1 rounded-full border border-slate-800 text-[10px] text-indigo-400 font-semibold tracking-wide uppercase">
                <Monitor className="h-3 w-3" />
                Preview Zoom: {(zoom * 100).toFixed(0)}%
              </div>

              {/* Zoom controls */}
              <div className="flex items-center gap-1">
                <button 
                  onClick={decreaseZoom}
                  className="bg-slate-800 hover:bg-slate-700 p-1.5 rounded-lg text-slate-300 transition"
                  title="Zoom Out"
                >
                  <ZoomOut className="h-4 w-4" />
                </button>
                <button 
                  onClick={() => setZoom(1.0)}
                  className="text-xs text-slate-400 hover:text-white px-2 py-1 hover:bg-slate-800 rounded-lg transition"
                >
                  Reset
                </button>
                <button 
                  onClick={increaseZoom}
                  className="bg-slate-800 hover:bg-slate-700 p-1.5 rounded-lg text-slate-300 transition"
                  title="Zoom In"
                >
                  <ZoomIn className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Canvas Area wrapper */}
            <div className="flex-1 overflow-auto p-8 flex items-start justify-center bg-slate-950">
              
              {/* Outer area wrapper matching PDF exports and native printed outputs */}
              <div 
                id="print-preview-area"
                className="bg-transparent shadow-2xl transition-transform"
              >
                {printMode === 'thermal' ? (
                  /* THERMAL PRINT PREVIEW MODEL */
                  /* In thermal mode, we stack pages sequentially representing individual sheets */
                  <div className="flex flex-col gap-3">
                    {labelsForActivePage.map((_, i) => (
                      <div 
                        key={i} 
                        className="print-page-target print-mode-roll border border-transparent shadow shadow-indigo-500/20 rounded-sm overflow-hidden"
                      >
                        <BarcodePreview product={product} scale={zoom} />
                      </div>
                    ))}
                  </div>
                ) : (
                  /* A4 SHEET PRINT PREVIEW MODEL */
                  /* Render beautiful virtual standard A4 sheet layouts with configured columns, margins & paddings */
                  <div 
                    className="print-page-target bg-white border border-gray-100 flex flex-col justify-start select-none transition-all text-black"
                    style={{
                      width: '210mm',
                      height: '297mm',
                      padding: `${marginMm}mm`,
                      boxSizing: 'border-box',
                      transform: `scale(${zoom})`,
                      transformOrigin: 'top center',
                      marginBottom: zoom !== 1.0 ? `${-297 * (1 - zoom)}mm` : '0',
                    }}
                  >
                    {/* Multi-up layout display grid in A4 sheet page */}
                    <div 
                      className="grid h-full w-full justify-start items-start"
                      style={{
                        gridTemplateColumns: `repeat(${cols}, 50mm)`,
                        gridTemplateRows: `repeat(${rows}, 25mm)`,
                        gap: `${gapMm}mm`,
                      }}
                    >
                      {labelsForActivePage.map((_, i) => (
                        <div key={i} className="w-[50mm] h-[25mm] select-none overflow-hidden origin-top-left">
                          <BarcodePreview product={product} scale={1.0} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            {/* Status footer inside preview */}
            <div className="p-3 bg-slate-900/50 border-t border-slate-800 flex justify-between text-[11px] text-slate-400 font-sans">
              <span>Layout Page Target: {printMode === 'thermal' ? '50mm × 25mm' : 'A4 Paper (210mm × 297mm)'}</span>
              <span>Showing Page {totalPages === 0 ? 0 : activePage + 1} of {totalPages} ({labelsForActivePage.length} items rendered)</span>
            </div>
          </div>
        </div>
      </div>
      {typeof document !== 'undefined' && createPortal(printPortalContent, document.body)}
    </div>
  );
}
