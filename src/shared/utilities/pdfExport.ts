import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { swapBarcodeSvgsForImages, restoreBarcodeSvgs } from './svgRasterize';

const LABEL_W_MM = 50;
const LABEL_H_MM = 30;

function stripOklch(clonedDoc: Document) {
  // html2canvas cannot parse oklch() (used by Tailwind v4).
  // Replace it in all <style> blocks; BarcodePreview is fully inline-styled
  // so visual output is unaffected.
  clonedDoc.querySelectorAll('style').forEach(style => {
    if (style.textContent?.includes('oklch')) {
      style.textContent = style.textContent.replace(/oklch\([^)]+\)/g, 'transparent');
    }
  });
  // Remove any linked stylesheets (production build) for the same reason.
  clonedDoc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach(l => l.remove());
}

/**
 * Captures each `.print-label-item` child of `container` with html2canvas
 * and writes them as individual pages (50×30mm) into a downloaded PDF.
 */
export async function downloadLabelsPdf(container: HTMLElement, filename: string): Promise<void> {
  // Wait for fonts and one animation frame so JsBarcode useEffects have run in all label instances
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  const items = Array.from(container.querySelectorAll<HTMLElement>('.print-label-item'));
  if (!items.length) return;

  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: [LABEL_W_MM, LABEL_H_MM]
  });

  // Swap barcode <svg>s for pre-rasterized <img>s in the LIVE container
  // before capturing anything — not inside html2canvas's `onclone`. An async
  // onclone (this rasterization fetches the embedded font) was observed to
  // race with html2canvas's own layout measurement, producing a
  // cropped/misaligned capture even though the barcode itself rendered
  // correctly. Swapping here means html2canvas only ever sees a plain,
  // already-loaded image — nothing async left for it to get out of sync with.
  const swaps = await swapBarcodeSvgsForImages(container);
  try {
    for (let i = 0; i < items.length; i++) {
      const canvas = await html2canvas(items[i], {
        scale: 4,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
        onclone: stripOklch
      });

      if (i > 0) pdf.addPage([LABEL_W_MM, LABEL_H_MM], 'landscape');
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, LABEL_W_MM, LABEL_H_MM);
    }
  } finally {
    restoreBarcodeSvgs(swaps);
  }

  pdf.save(filename);
}

/**
 * Same capture logic as downloadLabelsPdf but returns a Blob
 * instead of triggering a browser download. Used for server-side silent printing.
 */
export async function generateLabelsPdfBlob(container: HTMLElement): Promise<Blob> {
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  const items = Array.from(container.querySelectorAll<HTMLElement>('.print-label-item'));
  if (!items.length) throw new Error('No label items found in container.');

  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: [LABEL_W_MM, LABEL_H_MM]
  });

  const swaps = await swapBarcodeSvgsForImages(container);
  try {
    for (let i = 0; i < items.length; i++) {
      const canvas = await html2canvas(items[i], {
        scale: 4,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
        onclone: stripOklch
      });

      if (i > 0) pdf.addPage([LABEL_W_MM, LABEL_H_MM], 'landscape');
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, LABEL_W_MM, LABEL_H_MM);
    }
  } finally {
    restoreBarcodeSvgs(swaps);
  }

  return pdf.output('blob');
}
