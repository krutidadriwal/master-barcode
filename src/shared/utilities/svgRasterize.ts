// Fetched and base64-encoded once, then reused for every barcode rasterized
// in the session — an SVG loaded via a `data:` URL is sandboxed from the
// page's external stylesheets (no @font-face lookup outside the resource
// itself), so OCR-B has to be embedded directly into the SVG or it silently
// falls back to a generic font in the rasterized output.
let ocrbFontDataUrlPromise: Promise<string> | null = null;
function getOcrbFontDataUrl(): Promise<string> {
  if (!ocrbFontDataUrlPromise) {
    ocrbFontDataUrlPromise = fetch('/ocrb.ttf')
      .then(res => res.arrayBuffer())
      .then(buf => {
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return `data:font/ttf;base64,${btoa(binary)}`;
      });
  }
  return ocrbFontDataUrlPromise;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image.'));
    img.src = src;
  });
}

/**
 * Rasterizes a live SVG element into a PNG <img> at a given device-pixel
 * scale, preserving its current on-screen box size (via getBoundingClientRect)
 * so the resulting <img> can be swapped in 1:1 for the original <svg>.
 *
 * Used to work around html2canvas's unreliable handling of SVG <text>
 * elements set with a custom @font-face (font-family) — it sometimes drops
 * the text, substitutes a fallback font, or (with foreignObjectRendering)
 * renders nothing at all. A plain rasterized <img> has none of those risks;
 * html2canvas just copies pixels. The OCR-B font is embedded directly into
 * the SVG (as a base64 data URI) before rasterizing, since the `data:` URL
 * this gets loaded through can't see the page's own stylesheets.
 */
export async function rasterizeSvgToImage(svg: SVGSVGElement, scale: number): Promise<HTMLImageElement> {
  const rect = svg.getBoundingClientRect();
  const cssWidth = rect.width || svg.clientWidth || 1;
  const cssHeight = rect.height || svg.clientHeight || 1;

  const clone = svg.cloneNode(true) as SVGSVGElement;
  const fontDataUrl = await getOcrbFontDataUrl();
  const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.textContent = `@font-face { font-family: 'OCRB'; src: url(${fontDataUrl}) format('truetype'); }`;
  clone.insertBefore(styleEl, clone.firstChild);

  const serialized = new XMLSerializer().serializeToString(clone);
  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
  const sourceImage = await loadImage(svgDataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cssWidth * scale));
  canvas.height = Math.max(1, Math.round(cssHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable.');
  ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);

  // Wait for the final PNG to actually decode before handing it back — an
  // <img> whose data URL hasn't finished decoding yet can rasterize as blank
  // if something reads its pixels before it's ready.
  const result = await loadImage(canvas.toDataURL('image/png'));
  result.style.display = svg.style.display || 'block';
  result.style.width = `${cssWidth}px`;
  result.style.height = `${cssHeight}px`;
  return result;
}

export interface BarcodeSvgSwap {
  svg: SVGSVGElement;
  img: HTMLImageElement;
}

/**
 * Replaces every `[data-barcode-svg]` element within `root` with a
 * pre-rasterized <img> of identical box size, IN PLACE — this mutates
 * whatever DOM `root` actually belongs to.
 *
 * Deliberately used on the LIVE, already-rendered DOM (not inside
 * html2canvas's `onclone`) — an async `onclone` that does a `fetch()` (for
 * the embedded font) has been observed to race with html2canvas's own
 * layout measurement, producing cropped/misaligned captures. Swapping in the
 * live DOM first means html2canvas sees a plain, already-loaded <img> and
 * has nothing async left to wait for. Call `restoreBarcodeSvgs` afterward to
 * put the originals back.
 */
export async function swapBarcodeSvgsForImages(root: ParentNode, scale = 4): Promise<BarcodeSvgSwap[]> {
  const svgs = Array.from(root.querySelectorAll<SVGSVGElement>('svg[data-barcode-svg]'));
  const swaps: BarcodeSvgSwap[] = [];
  for (const svg of svgs) {
    try {
      const img = await rasterizeSvgToImage(svg, scale);
      svg.replaceWith(img);
      swaps.push({ svg, img });
    } catch (err) {
      console.warn('[svgRasterize] Failed to rasterize barcode SVG, leaving original element:', err);
    }
  }
  return swaps;
}

/** Undoes `swapBarcodeSvgsForImages` — puts each original <svg> back in place of its <img>. */
export function restoreBarcodeSvgs(swaps: BarcodeSvgSwap[]): void {
  for (const { svg, img } of swaps) {
    img.replaceWith(svg);
  }
}
