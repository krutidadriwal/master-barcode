import jsPDF from 'jspdf';
import JsBarcode from 'jsbarcode';
import { BarcodeGeneratorService } from '../../../shared/services/BarcodeGeneratorService';

export interface ReceivingSheetLine {
  line_id: string;
  po_id: string;
  po_ref_no: string | null;
  item_sku: string;
  ean_fnsku: string | null;
  item_name: string;
  qty: number;
  pending_qty: number;
  shipment_id: string | null;
}

export interface ReceivingSheetData {
  po_id: string | null;
  po_ref_no: string | null;
  shipment_id: string | null;
  batch_id: string | null;
  lines: ReceivingSheetLine[];
}

/**
 * Builds the receiving sheet as a landscape A4 PDF using jsPDF's NATIVE vector
 * text (setFont/setFontSize/text/splitTextToSize) — deliberately NOT
 * html2canvas. html2canvas measures text via the DOM, then compares that to
 * its own canvas-based text metrics and applies a compensating horizontal
 * scale when they don't match exactly — which is what caused the squeezed/
 * distorted lettering. Native jsPDF text has no such rasterize-then-stretch
 * step, so there's nothing to distort, and splitTextToSize gives real word
 * wrap within a fixed column width.
 *
 * Pagination is computed from ACTUALLY measured (wrapped) row heights in a
 * dry-run pass, not a guessed row-per-page count, so rows can never be
 * clipped off the bottom of a page.
 */

// Page geometry (mm), landscape.
const PAGE_W = 297;
const PAGE_H = 210;
const MARGIN = 10;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CONTENT_BOTTOM = PAGE_H - MARGIN;

// Header barcode geometry — matches the on-screen preview's proportions.
const BARCODE_HEIGHT_MM = 15;
const BARCODE_MODULE_WIDTH_MM = 0.3; // standard safe bar width for reliable scanning
const BARCODE_PX_PER_MM = 12;        // ~300 DPI equivalent raster resolution

// Fixed header block height (mm) reserved on every page: barcode label + the
// barcode image + its value line, plus the divider and page-indicator line.
const HEADER_BLOCK_H = 34;

const CELL_FONT_SIZE = 12;   // pt (~16px) — matches the on-screen preview ask
const HEADER_FONT_SIZE = 12;
const CELL_PADDING = 2;      // mm
const LINE_HEIGHT_FACTOR = 1.15;

type ColumnKey = 'index' | 'po_id' | 'po_ref_no' | 'item_sku' | 'ean_fnsku' | 'item_name' | 'qty' | 'inbound' | 'remark';

const COLUMNS: Array<{ key: ColumnKey; label: string; frac: number; align?: 'left' | 'right'; bold?: boolean }> = [
  { key: 'index',     label: '#',            frac: 0.04, align: 'right' },
  { key: 'po_id',     label: 'PO ID',        frac: 0.08 },
  { key: 'po_ref_no', label: 'PO Ref No.',   frac: 0.09 },
  { key: 'item_sku',  label: 'Item SKU',     frac: 0.08, bold: true },
  { key: 'ean_fnsku', label: 'EAN / FNSKU',  frac: 0.11 },
  { key: 'item_name', label: 'Item Name',    frac: 0.20 },
  { key: 'qty',       label: 'Qty',          frac: 0.06, align: 'right', bold: true },
  { key: 'inbound',   label: 'Inbound',      frac: 0.17 },
  { key: 'remark',    label: 'Remark',       frac: 0.17 },
];

const ptToMm = (pt: number) => pt * 0.3528;
const LINE_HEIGHT_MM = ptToMm(CELL_FONT_SIZE) * LINE_HEIGHT_FACTOR;
const TABLE_HEADER_ROW_H = ptToMm(HEADER_FONT_SIZE) * LINE_HEIGHT_FACTOR + CELL_PADDING * 2;
const TABLE_START_Y = MARGIN + HEADER_BLOCK_H;

function cellText(line: ReceivingSheetLine, key: ColumnKey, rowNumber: number): string {
  switch (key) {
    case 'index':       return String(rowNumber);
    case 'po_id':       return line.po_id || '';
    case 'po_ref_no':   return line.po_ref_no || '';
    case 'item_sku':    return line.item_sku || '';
    case 'ean_fnsku':   return line.ean_fnsku || '';
    case 'item_name':   return line.item_name || '';
    case 'qty':         return String(line.qty ?? '');
    case 'inbound':      return '';
    case 'remark':       return '';
    default:             return '';
  }
}

/** rowNumber is the line's 1-based position across the WHOLE sheet (continuous
 * across pages), not reset per page. */
function buildRow(line: ReceivingSheetLine, rowNumber: number): string[] {
  return COLUMNS.map(c => cellText(line, c.key, rowNumber));
}

function renderBarcodePng(value: string): { dataUrl: string; aspect: number } | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const format = BarcodeGeneratorService.detectFormat(v);
    const barcodeFormat = format === 'EAN13' ? 'EAN13' : format === 'UPC' ? 'UPC' : 'CODE128';
    const heightPx = BARCODE_HEIGHT_MM * BARCODE_PX_PER_MM;
    const moduleWidthPx = BARCODE_MODULE_WIDTH_MM * BARCODE_PX_PER_MM;
    const canvas = document.createElement('canvas');
    JsBarcode(canvas, v, {
      format: barcodeFormat,
      width: moduleWidthPx,
      height: heightPx,
      displayValue: false,
      margin: Math.round(moduleWidthPx * 10),
      background: '#FFFFFF',
      lineColor: '#000000',
    });
    return { dataUrl: canvas.toDataURL('image/png'), aspect: canvas.width / canvas.height };
  } catch (err) {
    console.warn('[ReceivingSheetPdfBuilder] barcode render failed:', err);
    return null;
  }
}

function computeRowHeight(pdf: jsPDF, row: string[], colWidths: number[]): { linesPerCol: string[][]; heightMm: number } {
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(CELL_FONT_SIZE);
  let maxLines = 1;
  const linesPerCol = row.map((text, i) => {
    const maxW = Math.max(colWidths[i] - CELL_PADDING * 2, 5);
    const lines: string[] = pdf.splitTextToSize(text || '', maxW);
    maxLines = Math.max(maxLines, lines.length || 1);
    return lines.length ? lines : [''];
  });
  const heightMm = maxLines * LINE_HEIGHT_MM + CELL_PADDING * 2;
  return { linesPerCol, heightMm };
}

function drawPageHeader(
  pdf: jsPDF,
  data: ReceivingSheetData,
  poBarcode: { dataUrl: string; aspect: number } | null,
  batchBarcode: { dataUrl: string; aspect: number } | null,
  pageIndex: number,
  totalPages: number
) {
  const topY = MARGIN;

  // PO REF NO. — label, barcode, and value all centered on the barcode's own
  // width (not left-aligned to its edge — the barcode's rendered width varies
  // with the encoded value's length, so left-aligning left label/value visibly
  // off-center against it).
  if (poBarcode) {
    const wMm = BARCODE_HEIGHT_MM * poBarcode.aspect;
    const centerX = MARGIN + wMm / 2;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('PO REF NO.', centerX, topY + 3, { align: 'center' });
    pdf.addImage(poBarcode.dataUrl, 'PNG', MARGIN, topY + 4, wMm, BARCODE_HEIGHT_MM);
    pdf.setFontSize(12);
    pdf.text(data.po_ref_no || '', centerX, topY + 4 + BARCODE_HEIGHT_MM + 4, { align: 'center' });
  }

  // BATCH — label, barcode, value (right) — only if a batch was resolved.
  if (batchBarcode && data.batch_id) {
    const wMm = BARCODE_HEIGHT_MM * batchBarcode.aspect;
    const batchX = PAGE_W - MARGIN - wMm;
    const centerX = batchX + wMm / 2;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('BATCH', centerX, topY + 3, { align: 'center' });
    pdf.addImage(batchBarcode.dataUrl, 'PNG', batchX, topY + 4, wMm, BARCODE_HEIGHT_MM);
    pdf.setFontSize(12);
    pdf.text(data.batch_id, centerX, topY + 4 + BARCODE_HEIGHT_MM + 4, { align: 'center' });
  }

  // Title + PO ID / Shipment ID (center)
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(20 * 0.75); // 20px ≈ 15pt
  pdf.text('Purchase Order Inbound Sheet', PAGE_W / 2, topY + 8, { align: 'center' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(12);
  pdf.text(`PO ID: ${data.po_id || ''}    Shipment ID: ${data.shipment_id || '—'}`, PAGE_W / 2, topY + 15, { align: 'center' });

  // Divider under the header block
  const dividerY = topY + BARCODE_HEIGHT_MM + 4 + 4 + 4; // label + barcode + gap + value line + padding
  pdf.setDrawColor(0);
  pdf.setLineWidth(0.6);
  pdf.line(MARGIN, dividerY, PAGE_W - MARGIN, dividerY);

  // Page indicator
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.text(`Page ${pageIndex + 1} of ${totalPages}`, PAGE_W - MARGIN, dividerY + 5, { align: 'right' });
}

function drawTableHeaderRow(pdf: jsPDF, colX: number[], colWidths: number[], y: number) {
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(HEADER_FONT_SIZE);
  pdf.setDrawColor(0);
  pdf.setLineWidth(0.3);
  const textY = y + CELL_PADDING + LINE_HEIGHT_MM * 0.75;
  COLUMNS.forEach((col, i) => {
    pdf.rect(colX[i], y, colWidths[i], TABLE_HEADER_ROW_H);
    const x = col.align === 'right' ? colX[i] + colWidths[i] - CELL_PADDING : colX[i] + CELL_PADDING;
    pdf.text(col.label, x, textY, col.align === 'right' ? { align: 'right' } : undefined);
  });
}

function drawRow(pdf: jsPDF, colX: number[], colWidths: number[], y: number, linesPerCol: string[][], heightMm: number) {
  pdf.setDrawColor(0);
  pdf.setLineWidth(0.3);
  COLUMNS.forEach((col, i) => {
    pdf.rect(colX[i], y, colWidths[i], heightMm);
    pdf.setFont('helvetica', col.bold ? 'bold' : 'normal');
    pdf.setFontSize(CELL_FONT_SIZE);
    const x = col.align === 'right' ? colX[i] + colWidths[i] - CELL_PADDING : colX[i] + CELL_PADDING;
    const lines = linesPerCol[i];
    lines.forEach((ln, li) => {
      const ly = y + CELL_PADDING + LINE_HEIGHT_MM * (li + 0.75);
      pdf.text(ln, x, ly, col.align === 'right' ? { align: 'right' } : undefined);
    });
  });
}

function buildDocument(data: ReceivingSheetData): jsPDF {
  const poBarcode = data.po_ref_no ? renderBarcodePng(data.po_ref_no) : null;
  const batchBarcode = data.batch_id ? renderBarcodePng(data.batch_id) : null;

  const pdf = new jsPDF({ orientation: 'l', unit: 'mm', format: [PAGE_W, PAGE_H] });

  const colWidths = COLUMNS.map(c => c.frac * CONTENT_W);
  const colX: number[] = [];
  {
    let x = MARGIN;
    for (const w of colWidths) { colX.push(x); x += w; }
  }

  // Pass 1 (dry run): paginate using real measured (wrapped) row heights.
  // Row numbers are continuous across the whole sheet, not reset per page.
  const pages: Array<Array<{ line: ReceivingSheetLine; rowNumber: number }>> = [];
  let current: Array<{ line: ReceivingSheetLine; rowNumber: number }> = [];
  let cursorY = TABLE_START_Y + TABLE_HEADER_ROW_H;
  data.lines.forEach((line, i) => {
    const rowNumber = i + 1;
    const row = buildRow(line, rowNumber);
    const { heightMm } = computeRowHeight(pdf, row, colWidths);
    if (current.length > 0 && cursorY + heightMm > CONTENT_BOTTOM) {
      pages.push(current);
      current = [];
      cursorY = TABLE_START_Y + TABLE_HEADER_ROW_H;
    }
    current.push({ line, rowNumber });
    cursorY += heightMm;
  });
  if (current.length > 0 || pages.length === 0) pages.push(current);

  // Pass 2: draw, now that the total page count is known.
  pages.forEach((pageLines, pageIndex) => {
    if (pageIndex > 0) pdf.addPage([PAGE_W, PAGE_H], 'l');
    drawPageHeader(pdf, data, poBarcode, batchBarcode, pageIndex, pages.length);
    drawTableHeaderRow(pdf, colX, colWidths, TABLE_START_Y);
    let y = TABLE_START_Y + TABLE_HEADER_ROW_H;
    for (const { line, rowNumber } of pageLines) {
      const row = buildRow(line, rowNumber);
      const { linesPerCol, heightMm } = computeRowHeight(pdf, row, colWidths);
      drawRow(pdf, colX, colWidths, y, linesPerCol, heightMm);
      y += heightMm;
    }
  });

  return pdf;
}

export async function downloadReceivingSheetPdf(data: ReceivingSheetData, filename: string): Promise<void> {
  const pdf = buildDocument(data);
  pdf.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}

export async function printReceivingSheetPdf(data: ReceivingSheetData): Promise<void> {
  const pdf = buildDocument(data);
  const blobUrl = pdf.output('bloburl') as unknown as string;

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  iframe.src = blobUrl;

  document.body.appendChild(iframe);
  await new Promise<void>(resolve => {
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (err) {
        console.warn('[ReceivingSheetPdfBuilder] Failed to trigger print on PDF iframe:', err);
      }
      resolve();
    };
  });

  setTimeout(() => {
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    URL.revokeObjectURL(blobUrl);
  }, 60_000);
}
