import { ProductionOrderRow, SyncResult } from './types.js';
import { ProductionOrderRepository } from './ProductionOrderRepository.js';

interface GSheetRow {
  reference_code_original: string;
  reference_code_short: string;
  import_date: string | null;
  order_quantity: number;
  item_status: string;
  suborder_quantity: number;
  item_quantity: number;
  returned_quantity: number;
  cancelled_quantity: number;
  shipped_quantity: number;
  sku: string;
  sub_product_count: number;
  product_name: string;
  brand: string;
  model_no: string;
  ean: string;
  size: string;
}

interface GSheetResponse {
  success: boolean;
  count?: number;
  rows?: GSheetRow[];
  error?: string;
}

function toInt(val: any): number {
  const n = parseInt(String(val ?? 0), 10);
  return isNaN(n) ? 0 : n;
}

function normalizeRow(raw: GSheetRow): ProductionOrderRow | null {
  const refCode = (raw.reference_code_original || '').toString().trim();
  const sku     = (raw.sku || '').toString().trim();
  if (!refCode || !sku) return null;

  return {
    reference_code_original: refCode,
    reference_code_short:    refCode.slice(-5),
    import_date:             (raw.import_date || '').toString().trim(),
    order_quantity:          toInt(raw.order_quantity),
    item_status:             (raw.item_status || '').toString().trim(),
    suborder_quantity:       toInt(raw.suborder_quantity),
    item_quantity:           toInt(raw.item_quantity),
    returned_quantity:       toInt(raw.returned_quantity),
    cancelled_quantity:      toInt(raw.cancelled_quantity),
    shipped_quantity:        toInt(raw.shipped_quantity),
    sku,
    sub_product_count:       toInt(raw.sub_product_count),
    product_name:            (raw.product_name || '').toString().trim(),
    brand:                   (raw.brand        || '').toString().trim(),
    model_no:                (raw.model_no     || '').toString().trim(),
    ean:                     (raw.ean          || '').toString().trim(),
    size:                    (raw.size         || '').toString().trim(),
  };
}

export class ProductionOrderGSheetSyncService {
  private repo: ProductionOrderRepository;
  private scriptUrl: string;

  constructor() {
    this.repo      = new ProductionOrderRepository();
    this.scriptUrl = (process.env.MASTER_BARCODE_SCRIPTS_URL || '').trim();
  }

  async sync(): Promise<SyncResult> {
    if (!this.scriptUrl) {
      throw new Error(
        'MASTER_BARCODE_SCRIPTS_URL is not set. ' +
        'Add it to your .env and deploy the ProductionOrders.gs web app.'
      );
    }

    const url = `${this.scriptUrl}${this.scriptUrl.includes('?') ? '&' : '?'}request=production_orders`;
    console.log('[PO GSheet Sync] Fetching from:', url);

    const res = await fetch(url, {
      method:  'GET',
      headers: { 'Accept': 'application/json' },
      // Google Apps Script redirects — Node's fetch follows them by default
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Apps Script fetch failed (${res.status}): ${body}`);
    }

    const json: GSheetResponse = await res.json();

    if (!json.success) {
      throw new Error(`Apps Script returned error: ${json.error || 'unknown'}`);
    }

    const rawRows: GSheetRow[] = json.rows || [];
    console.log(`[PO GSheet Sync] Received ${rawRows.length} rows from sheet.`);

    const rows: ProductionOrderRow[] = rawRows
      .map(normalizeRow)
      .filter((r): r is ProductionOrderRow => r !== null);

    console.log(`[PO GSheet Sync] Normalized ${rows.length} valid rows. Upserting...`);

    const dbResult = await this.repo.upsertOrders(rows);

    console.log('[PO GSheet Sync] Complete:', dbResult);
    return dbResult;
  }
}
