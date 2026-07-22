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

        // JsBarcode's SVG output always carries a viewBox, so the CSS box
        // below (fixed 27mm x 10mm) scales it uniformly (preserveAspectRatio
        // defaults to "xMidYMid meet") — never a non-uniform X/Y stretch.
        // That means the `width` option's absolute value barely matters here
        // (it's pre-scale units, not a physical size); what matters is that
        // `margin` stays proportional to it so the quiet zone survives the
        // scale-to-fit as a fixed fraction of the total symbol width. Kept
        // as a constant rather than branching by value length — the old
        // 1.1/1.4 split didn't change the final on-label size (both get
        // scaled to fit the same fixed box) and was pure cargo-cult.
        const moduleWidth = 2;
        JsBarcode(svgRef.current, value.trim(), {
          format: format === 'EAN13' ? 'EAN13' : format === 'UPC' ? 'UPC' : 'CODE128',
          width: moduleWidth,
          // At the box aspect ratio actually in use, this (combined with
          // fontSize+textMargin below) keeps the barcode HEIGHT-bound — the
          // rendered symbol fills the CSS box's full height and letterboxes
          // narrower than its width, rather than stretching to fill the
          // width. That's intentional here: the CSS box below is sized with
          // deliberate width slack specifically so that increasing box
          // height (the actual lever for growing this barcode) also grows
          // the rendered width proportionally, with no risk of ever
          // exceeding the box and no need to touch these numbers to do it.
          height: 56,
          // Use JsBarcode's own human-readable text instead of a hand-rolled
          // div below the SVG. For EAN13/UPC this renders the standard
          // grouped layout (lone check-adjacent digit outside the guard
          // bars, then two digit groups under the left/right halves) —
          // that's the "wrap around" look, and it's what a laser-scanner
          // operator expects to visually cross-check against a misread. It
          // also guarantees the text sits at a scanner-safe distance from
          // the bars (never inside the quiet zone) since JsBarcode computes
          // that placement itself instead of us guessing an outer margin.
          displayValue: true,
          font: 'OCRB',
          fontOptions: '', // not bold — the @font-face for OCRB only has a normal-weight cut anyway
          fontSize: 16,
          textMargin: 3, // tight gap between bars and text, in the same unit scale as `width`/`height`
          textAlign: 'center',
          background: '#FFFFFF',
          lineColor: '#000000',
          // Quiet zone: symbology spec requires >=10x the narrow-bar width on
          // each side. The old margin:0 stripped this entirely, which is one
          // of the most common reasons a barcode scans fine on a phone camera
          // (which can crop/decode from context) but fails on a laser scanner
          // (which needs the blank zone to detect where the symbol starts).
          // This does mean bars end up a bit thinner than before within the
          // same fixed 27mm box — quiet zone has to come from somewhere, and
          // an unscannable barcode with fat bars is worse than a scannable
          // one with a correct margin.
          margin: Math.round(moduleWidth * 10),
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
      // Non-visual marker only — lets the PDF/print export code find and
      // pre-rasterize this exact element before html2canvas runs, without
      // changing anything about how it looks on screen.
      data-barcode-svg="true"
      style={{
        display: 'block',
        margin: '0 auto',
        background: '#FFFFFF',
        // Fixing both width and height here does NOT non-uniformly stretch
        // the bars: JsBarcode's SVG always carries a viewBox, so the browser
        // applies its default preserveAspectRatio ("xMidYMid meet") — a
        // single uniform scale that letterboxes rather than distorts. This
        // box is sized to the label's reserved barcode slot.
        // Note: this box is currently HEIGHT-bound (naturalAspect from the
        // JsBarcode options below is well under this box's own aspect ratio),
        // meaning the rendered barcode fills the full height and letterboxes
        // narrower than the box width — there's deliberately generous slack
        // on width so that growing height alone (the actual lever here) has
        // room to also grow the rendered width proportionally without ever
        // needing to touch the JsBarcode options themselves.
        height: '16mm',
        width: '46mm',
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
      document.fonts.load('normal 12px "OCRB"'), // matches JsBarcode's fontOptions:'' (not bold) below
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
      return document.fonts.check('normal 12px "OCRB"') && document.fonts.check('normal 12px "Rubik-Light"');
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

  // Item name is capped at 2 lines — an unusually long name can otherwise push
  // the barcode down far enough to run past the 30mm label edge and get cut
  // off by the printer. Measured against the live DOM (not a fixed character
  // count) so the cutoff point stays accurate regardless of font metrics or
  // column width, and matches exactly what html2canvas will later rasterize
  // for print/export (it captures this same DOM, not a separate render path).
  const nameRef = useRef<HTMLDivElement>(null);
  const [displayName, setDisplayName] = useState(product.product_name || '');

  useEffect(() => {
    const fullName = product.product_name || '';
    const el = nameRef.current;
    if (!fontsReady || !el) { setDisplayName(fullName); return; }

    const lineHeightPx = parseFloat(getComputedStyle(el).lineHeight)
      || parseFloat(getComputedStyle(el).fontSize) * 1.2;
    const maxHeightPx = lineHeightPx * 2 + 1; // +1px rounding tolerance

    const previous = el.textContent;
    el.textContent = fullName;
    if (el.scrollHeight <= maxHeightPx) {
      el.textContent = previous;
      setDisplayName(fullName);
      return;
    }

    // Binary search the longest prefix (+ "...") that still fits in 2 lines.
    let lo = 0, hi = fullName.length, best = '...';
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = fullName.slice(0, mid).trimEnd() + '...';
      el.textContent = candidate;
      if (el.scrollHeight <= maxHeightPx) { best = candidate; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    el.textContent = previous;
    setDisplayName(best);
  }, [product.product_name, fontsReady]);

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
        padding: '1.2mm 1.8mm 0 1.8mm',
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
          gridTemplateColumns: '13.5mm 2mm 1fr',
          rowGap: '0.3mm',
          columnGap: '0px',
          fontFamily: "'Rubik-Light', 'Rubik'",
          fontSize: '8px',
          fontWeight: 700,
          color: '#000000',
          backgroundColor: '#FFFFFF',
          lineHeight: '1',
          // Leaves room on the right for the vertical "Cubelelo.com" strip
          // (reserved 4mm + 0.8mm gap) so a long wrapped item name can't run
          // underneath it.
          width: 'calc(100% - 4.8mm)',
          boxSizing: 'border-box'
        }}
      >
        {/* Row 1: Item */}
        <div style={{ fontWeight: 700 }}>Item</div>
        <div>:</div>
        <div
          ref={nameRef}
          style={{
            wordBreak: 'break-word', whiteSpace: 'normal', fontWeight: 700, paddingRight: '0.5mm',
            overflow: 'hidden', maxHeight: '2em',
          }}
        >
          {displayName}
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
          {formatMrp(product.mrp)}<span style={{ fontSize: '6.5px', fontWeight: 600 }}> (Incl. of all taxes)</span>
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

      {/* Flexible spacer — absorbs whatever vertical space is actually left
          after the (untouched) info block above, so the barcode section
          below always sits balanced in the remaining space instead of at a
          hand-guessed fixed offset. This is what fixes "barcode positioned
          too high / bottom section compressed": previously the barcode
          block was `position: absolute; bottom: 1.5mm`, which pins it near
          the bottom regardless of how much (or little) space the info block
          actually used above it, producing an uneven gap. Letting the
          browser distribute the real leftover space removes that guesswork
          entirely — nothing about the barcode's own size, the info block, or
          any font/spacing changed to achieve this, only how the remaining
          space between them is allocated. */}
      <div style={{ flex: '1 1 auto' }} />

      {/* Bottom section: Barcode (bars + human-readable text drawn together
          by JsBarcode itself — see displayValue above) and the vertical
          "Cubelelo.com" strip, as a row. Putting them in the same flex row
          with alignItems:'center' ties the website text's vertical position
          directly to the barcode's own height — it used to be independently
          stretched across the whole label height (top:0 to bottom:0), which
          is why it read as "too low" relative to the barcode above it; now
          it can only ever sit centered against whatever the barcode's actual
          height is. Barcode box itself (46mm x 16mm) and its JsBarcode
          options are completely unchanged — only its positioning (absolute
          -> normal flex flow, centered in the space left of the website
          strip) changed. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          width: '100%',
          boxSizing: 'border-box',
          gap: '1mm'
        }}
      >
        {/* Centers the barcode horizontally within the space left of the
            website strip, addressing "barcode not visually centered in the
            lower half" — previously it was pinned hard against the right
            edge (right: 3.2mm) with no centering at all. */}
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#FFFFFF',
              width: '46mm',
              height: '16mm',
              flexShrink: 0
            }}
          >
            <BarcodeImage value={barcodeValue} format={autoFormat} heightMm={35} />
          </div>
        </div>

        {/* Vertical "Cubelelo.com" strip — sized to its own content instead
            of stretched across the full label height, so the shared row's
            alignItems:'center' can actually align it against the barcode's
            height rather than the whole label. Rotation, font, and letter
            spacing are all unchanged. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '2.6mm',
            flexShrink: 0
          }}
        >
          <span
            style={{
              display: 'inline-block',
              transform: 'rotate(-90deg)',
              transformOrigin: 'center',
              whiteSpace: 'nowrap',
              fontFamily: "'Rubik-Light', 'Rubik'",
              fontSize: '5px',
              fontWeight: 'bold',
              color: '#000000',
              letterSpacing: '0.2px',
              lineHeight: '1.0'
            }}
          >
            www.cubelelo.com
          </span>
        </div>
      </div>

      {/* Small fixed bottom margin — keeps the barcode value off the label's
          bottom edge ("barcode numbers too close to the bottom edge"). */}
      <div style={{ height: '1.2mm', flexShrink: 0 }} />
    </div>
  );
}
