import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

const LABEL_W_MM = 50;
const LABEL_H_MM = 30;

/**
 * Captures each `.print-label-item` child of `container` with html2canvas
 * and writes them as individual pages (50×30mm) into a downloaded PDF.
 */
export async function downloadLabelsPdf(container: HTMLElement, filename: string): Promise<void> {
  const items = Array.from(container.querySelectorAll<HTMLElement>('.print-label-item'));
  if (!items.length) return;

  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: [LABEL_W_MM, LABEL_H_MM]
  });

  for (let i = 0; i < items.length; i++) {
    const canvas = await html2canvas(items[i], {
      scale: 4,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      onclone: (clonedDoc) => {
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
    });

    if (i > 0) pdf.addPage([LABEL_W_MM, LABEL_H_MM], 'landscape');
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, LABEL_W_MM, LABEL_H_MM);
  }

  pdf.save(filename);
}

/**
 * Same capture logic as downloadLabelsPdf but returns a Blob
 * instead of triggering a browser download. Used for server-side silent printing.
 */
export async function generateLabelsPdfBlob(container: HTMLElement): Promise<Blob> {
  const items = Array.from(container.querySelectorAll<HTMLElement>('.print-label-item'));
  if (!items.length) throw new Error('No label items found in container.');

  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: [LABEL_W_MM, LABEL_H_MM]
  });

  for (let i = 0; i < items.length; i++) {
    const canvas = await html2canvas(items[i], {
      scale: 4,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      onclone: (clonedDoc) => {
        clonedDoc.querySelectorAll('style').forEach(style => {
          if (style.textContent?.includes('oklch')) {
            style.textContent = style.textContent.replace(/oklch\([^)]+\)/g, 'transparent');
          }
        });
        clonedDoc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach(l => l.remove());
      }
    });

    if (i > 0) pdf.addPage([LABEL_W_MM, LABEL_H_MM], 'landscape');
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, LABEL_W_MM, LABEL_H_MM);
  }

  return pdf.output('blob');
}
