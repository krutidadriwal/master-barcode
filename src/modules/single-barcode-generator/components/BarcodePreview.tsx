import { useEffect, useRef } from 'react';
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
}

export function BarcodePreview({ product, scale = 1.0, batchNo }: BarcodePreviewProps) {
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

  // Prioritize custom_ean for barcode bars. Fallback to SKU.
  const barcodeValue = (product.custom_ean && product.custom_ean.trim() !== '')
    ? product.custom_ean.trim()
    : (product.sku && product.sku.trim() !== '' ? product.sku.trim() : '990011');

  // Detect format dynamically using shared services
  const autoFormat = BarcodeGeneratorService.detectFormat(barcodeValue);

  return (
    <div 
      className="relative flex flex-col justify-start select-none overflow-hidden origin-top-left bg-white text-black"
      style={{
        width: '50mm',
        height: '30mm',
        padding: '0.5mm 2.5mm 0 2.5mm',
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
          rowGap: '0.4mm',
          columnGap: '0px',
          fontFamily: "'Rubik-Light', 'Rubik', sans-serif",
          fontSize: '6px',
          fontWeight: 'normal',
          color: '#000000',
          backgroundColor: '#FFFFFF',
          lineHeight: '1',
          width: '100%',
          boxSizing: 'border-box'
        }}
      >
        {/* Row 1: Item */}
        <div style={{ fontWeight: 600 }}>Item</div>
        <div>:</div>
        <div style={{ wordBreak: 'break-word', whiteSpace: 'normal', fontWeight: 500, paddingRight: '0.5mm' }}>
          {product.item_name}
        </div>

        {/* Row 2: Item No */}
        <div style={{ fontWeight: 600 }}>Item No</div>
        <div>:</div>
        <div style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
          {product.sku || '990011'}
        </div>

        {/* Row 3: MRP */}
        <div style={{ fontWeight: 600 }}>MRP</div>
        <div>:</div>
        <div style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
          {formatMrp(product.mrp)}
        </div>

        {/* Row 4: Batch No — prop overrides product field */}
        {(batchNo ?? product.batch_no)?.trim() && (
          <>
            <div style={{ fontWeight: 600 }}>Batch No</div>
            <div>:</div>
            <div style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
              {(batchNo ?? product.batch_no)!.trim()}
            </div>
          </>
        )}
      </div>

      {/* Bottom section: Barcode, Barcode Value & Website url */}
      <div 
        style={{
          position: 'absolute',
          right: '2.5mm',
          bottom: '4mm',
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
            fontFamily: "'OCRB', monospace",
            fontSize: '7px',
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
          bottom: '4mm',
          fontFamily: "'Rubik-Light', 'Rubik', sans-serif",
          fontSize: '6px',
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
