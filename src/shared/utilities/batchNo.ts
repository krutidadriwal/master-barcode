/**
 * Single-barcode labels: KL + YY + MM  (e.g. KL2606 for June 2026)
 */
export function generateSingleBarcodeBatchNo(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `KL${yy}${mm}`;
}

/**
 * Shipment labels: A-YYMMDD (AIR) or S-YYMMDD (SEA)  (e.g. A-260619)
 */
export function generateShipmentBatchNo(mode: 'AIR' | 'SEA'): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const prefix = mode === 'AIR' ? 'A' : 'S';
  return `${prefix}-${yy}${mm}${dd}`;
}
