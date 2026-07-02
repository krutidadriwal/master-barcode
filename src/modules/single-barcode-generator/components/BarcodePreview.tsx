import { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { Product } from '../../../shared/types';
import { BarcodeGeneratorService, BarcodeType } from '../../../shared/services/BarcodeGeneratorService';

interface BarcodeImageProps {
  value: string;
  format: BarcodeType;
  heightMm: number;
}

export function BarcodeImage({ value, format }: BarcodeImageProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (svgRef.current) {
      try {
        // Clear old rendering remnants
        while (svgRef.current.firstChild) {
          svgRef.current.removeChild(svgRef.current.firstChild);
        }

        JsBarcode(svgRef.current, value.trim(), {
          format: format === 'EAN13' ? 'EAN13' : format === 'UPC' ? 'UPC' : 'CODE128',
          width: value.trim().length > 10 ? 1.1 : 1.4, // Keep bars clear and scan-safe
          height: 35, // Sharp pixel height
          displayValue: false, // We render custom OCR-B below for exact font specs
          background: '#FFFFFF',
          lineColor: '#000000',
          margin: 0
        });
      } catch (err) {
        console.warn('[Barcode Preview] jsbarcode failed:', err);
      }
    }
  }, [value, format]);

  return (
    <svg 
      ref={svgRef} 
      className="select-none"
      style={{
        display: 'block',
        margin: '0 auto',
        background: '#FFFFFF',
        height: '10mm',
        width: '27mm',
        shapeRendering: 'crispEdges'
      }}
    />
  );
}

interface BarcodePreviewProps {
  product: Product;
  quantity?: number;
  isSelected?: boolean;
  scale?: number; // Visual preview scaling factor on screen
  batchNo?: string; // Overrides product.batch_no when provided
  useStrippedSku?: boolean; // Show numeric-root SKU in Item No (production order use)
}

// Module-level singleton — font loading fires once, all instances share the result
let _fontsReadyPromise: Promise<void> | null = null;
function getFontsReady(): Promise<void> {
  if (!_fontsReadyPromise) {
    _fontsReadyPromise = Promise.all([
      document.fonts.load('bold 12px "OCRB"'),
      document.fonts.load('normal 12px "Rubik-Light"'),
      document.fonts.ready,
    ]).then(() => {}).catch(() => {}); // never reject — show label regardless on error
  }
  return _fontsReadyPromise;
}

function useFontsReady(): boolean {
  const [ready, setReady] = useState(() => {
    // If fonts are already loaded (e.g. off-screen container mounting after first preview),
    // skip the skeleton entirely by checking synchronously.
    try {
      return document.fonts.check('bold 12px "OCRB"') && document.fonts.check('normal 12px "Rubik-Light"');
    } catch { return false; }
  });
  useEffect(() => {
    if (ready) return;
    getFontsReady().then(() => setReady(true));
  }, []);
  return ready;
}

export function BarcodePreview({ product, scale = 1.0, batchNo, useStrippedSku = false }: BarcodePreviewProps) {
  const fontsReady = useFontsReady();
  // Safe formatting Helper
  const formatMrp = (rawMrp: string) => {
    const clean = rawMrp.trim();
    if (!clean) return 'Rs. -/-';
    if (/^rs/i.test(clean) || clean.toLowerCase() === '-/-') {
      return clean;
    }
    if (/^\d+(\.\d+)?$/.test(clean)) {
      return `Rs. ${clean}/-`;
    }
    if (clean.includes('/-')) {
      if (!/^Rs\./i.test(clean)) {
        return `Rs. ${clean}`;
      }
      return clean;
    }
    return `Rs. ${clean}/-`;
  };

  const validBarcode = (val?: string) => { const v = val?.trim() ?? ''; return v !== '' && v !== '0' && !/0{5,}$/.test(v); };

  // Barcode priority: EANUPC → sku numeric root (skips empty or literal "0")
  const skuRoot = (product.sku?.trim() || '990011').replace(/[^0-9]+$/i, '') || product.sku?.trim() || '990011';
  const barcodeValue = validBarcode(product.EANUPC)
    ? product.EANUPC!.trim()
    : skuRoot;

  // Detect format dynamically using shared services
  const autoFormat = BarcodeGeneratorService.detectFormat(barcodeValue);

  if (!fontsReady) {
    return (
      <div
        style={{
          width: '50mm', height: '30mm',
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          marginBottom: scale !== 1.0 ? `${-30 * (1 - scale)}mm` : '0',
          marginRight:  scale !== 1.0 ? `${-50 * (1 - scale)}mm` : '0',
          background: '#ffffff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <div style={{
          width: '80%', height: '60%', borderRadius: '2px',
          background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.2s infinite',
        }} />
      </div>
    );
  }

  return (
    <div
      className="relative flex flex-col justify-start select-none overflow-hidden origin-top-left bg-white text-black"
      style={{
        width: '50mm',
        height: '30mm',
        padding: '2mm 2.5mm 0 2.5mm',
        boxSizing: 'border-box',
        transform: `scale(${scale})`,
        marginBottom: scale !== 1.0 ? `${-30 * (1 - scale)}mm` : '0',
        marginRight: scale !== 1.0 ? `${-50 * (1 - scale)}mm` : '0',
        lineHeight: '1'
      }}
    >
      {/* Top section: Structured Two-Column Information Block */}
      <div 
        style={{
          display: 'grid',
          gridTemplateColumns: '13mm 2mm 1fr',
          rowGap: '0.5mm',
          columnGap: '0px',
          fontFamily: "'Rubik-Light', 'Rubik'",
          fontSize: '7px',
          fontWeight: 700,
          color: '#000000',
          backgroundColor: '#FFFFFF',
          lineHeight: '1',
          width: '100%',
          boxSizing: 'border-box'
        }}
      >
        {/* Row 1: Item */}
        <div style={{ fontWeight: 700 }}>Item</div>
        <div>:</div>
        <div style={{ wordBreak: 'break-word', whiteSpace: 'normal', fontWeight: 700, paddingRight: '0.5mm' }}>
          {product.product_name}
        </div>

        {/* Row 2: Item No */}
        <div style={{ fontWeight: 700 }}>Item No</div>
        <div>:</div>
        <div style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
          {useStrippedSku ? skuRoot : (product.sku || '990011')}
        </div>

        {/* Row 3: MRP */}
        <div style={{ fontWeight: 700 }}>MRP</div>
        <div>:</div>
        <div style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
          {formatMrp(product.mrp)}<span style={{ fontSize: '5.5px', fontWeight: 600 }}> (Incl. of all taxes)</span>
        </div>

        {/* Row 4: Batch No — from prop only */}
        {batchNo?.trim() && (
          <>
            <div style={{ fontWeight: 700 }}>Batch No</div>
            <div>:</div>
            <div style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
              {batchNo.trim()}
            </div>
          </>
        )}
      </div>

      {/* Bottom section: Barcode, Barcode Value & Website url */}
      <div 
        style={{
          position: 'absolute',
          right: '2.5mm',
          bottom: '2mm',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          backgroundColor: '#FFFFFF',
          zIndex: 10,
          width: '27mm'
        }}
      >
        {/* Barcode vector bars */}
        <div style={{ height: '10mm', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '27mm' }}>
          <BarcodeImage value={barcodeValue} format={autoFormat} heightMm={35} />
        </div>

        {/* Barcode OCR-B Value */}
        <div 
          style={{
            fontFamily: "'OCRB'",
            fontSize: '11px',
            fontWeight: 700,
            color: '#000000',
            textAlign: 'center',
            marginTop: '0.4mm',
            lineHeight: '1.0',
            letterSpacing: '0.8px',
            width: '27mm'
          }}
        >
          {barcodeValue}
        </div>
      </div>

      {/* Website URL anchor absolute positioned on the deep bottom-left of the 50mm x 30mm boundary */}
      <span 
        style={{
          position: 'absolute',
          left: '2.5mm',
          bottom: '2mm',
          fontFamily: "'Rubik-Light', 'Rubik'",
          fontSize: '7px',
          fontWeight: 'bold',
          color: '#000000',
          textDecoration: 'none',
          lineHeight: '1.0',
          zIndex: 10
        }}
      >
        www.cubelelo.com
      </span>
    </div>
  );
}
