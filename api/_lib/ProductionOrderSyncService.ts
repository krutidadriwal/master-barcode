import { ProductionOrderRow, SyncResult } from './types';
import { ProductionOrderRepository } from './ProductionOrderRepository';

interface EasyEcomTokenResponse {
  data?: { token?: string; jwt_token?: string };
  token?: string;
}

interface EasyEcomOrderRecord {
  reference_code?: string;
  import_date?: string;
  order_quantity?: number | string;
  item_status?: string;
  suborder_quantity?: number | string;
  item_quantity?: number | string;
  returned_quantity?: number | string;
  cancelled_quantity?: number | string;
  shipped_quantity?: number | string;
  sku?: string;
  sub_product_count?: number | string;
  productName?: string;
  brand?: string;
  model_no?: string;
  ean?: string;
  size?: string;
  [key: string]: any;
}

interface EasyEcomOrdersResponse {
  data?: {
    orders?: EasyEcomOrderRecord[];
    order_data?: EasyEcomOrderRecord[];
    [key: string]: any;
  };
  orders?: EasyEcomOrderRecord[];
  [key: string]: any;
}

function fmt(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function buildChunks(startDate: Date, endDate: Date, chunkDays = 7): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = new Date(startDate);
  while (cursor < endDate) {
    const chunkEnd = addDays(cursor, chunkDays);
    chunks.push({
      start: fmt(cursor),
      end: fmt(chunkEnd > endDate ? endDate : chunkEnd),
    });
    cursor = chunkEnd;
  }
  return chunks;
}

function toInt(val: any): number {
  const n = parseInt(String(val ?? 0), 10);
  return isNaN(n) ? 0 : n;
}

function normalizeRow(raw: EasyEcomOrderRecord): ProductionOrderRow | null {
  const refOriginal = (raw.reference_code || '').toString().trim();
  const sku = (raw.sku || '').toString().trim();
  if (!refOriginal || !sku) return null;

  return {
    reference_code_original: refOriginal,
    reference_code_short: refOriginal.slice(-5),
    import_date: (raw.import_date || '').toString().trim(),
    order_quantity: toInt(raw.order_quantity),
    item_status: (raw.item_status || '').toString().trim(),
    suborder_quantity: toInt(raw.suborder_quantity),
    item_quantity: toInt(raw.item_quantity),
    returned_quantity: toInt(raw.returned_quantity),
    cancelled_quantity: toInt(raw.cancelled_quantity),
    shipped_quantity: toInt(raw.shipped_quantity),
    sku,
    sub_product_count: toInt(raw.sub_product_count),
    product_name: (raw.productName || raw.product_name || '').toString().trim(),
    brand: (raw.brand || '').toString().trim(),
    model_no: (raw.model_no || '').toString().trim(),
    ean: (raw.ean || '').toString().trim(),
    size: (raw.size || '').toString().trim(),
  };
}

export class ProductionOrderSyncService {
  private repo: ProductionOrderRepository;
  private baseUrl: string;
  private email: string;
  private password: string;

  constructor() {
    this.repo = new ProductionOrderRepository();
    this.baseUrl = (process.env.EASYECOM_BASE_URL || 'https://api.easyecom.io').replace(/\/$/, '');
    this.email = process.env.EASYECOM_EMAIL || '';
    this.password = process.env.EASYECOM_PASSWORD || '';
  }

  async generateToken(): Promise<string> {
    if (!this.email || !this.password) {
      throw new Error('EASYECOM_EMAIL and EASYECOM_PASSWORD environment variables are required.');
    }

    const url = `${this.baseUrl}/auth/getAccessToken`;
    console.log(`[PO Sync] Generating EasyEcom token from ${url}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password, grant_type: 'password' }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`EasyEcom auth failed (${res.status}): ${body}`);
    }

    const json: EasyEcomTokenResponse = await res.json();
    const token = json?.data?.token || json?.data?.jwt_token || json?.token;
    if (!token) {
      throw new Error(`EasyEcom auth response missing token field. Response: ${JSON.stringify(json)}`);
    }

    console.log('[PO Sync] Token generated successfully.');
    return token;
  }

  private async fetchChunk(
    token: string,
    startDate: string,
    endDate: string
  ): Promise<EasyEcomOrderRecord[]> {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      limit: '250',
      order_type: '3',
      status_id: '1,2',
    });

    const url = `${this.baseUrl}/orders/V2/getAllOrders?${params.toString()}`;
    console.log(`[PO Sync] Fetching chunk ${startDate} → ${endDate}`);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`EasyEcom orders fetch failed (${res.status}) for ${startDate}→${endDate}: ${body}`);
    }

    const json: EasyEcomOrdersResponse = await res.json();

    // Handle different response envelope shapes
    const records: EasyEcomOrderRecord[] =
      json?.data?.orders ||
      json?.data?.order_data ||
      json?.orders ||
      (Array.isArray(json?.data) ? (json.data as any) : []);

    console.log(`[PO Sync] Chunk ${startDate}→${endDate}: ${records.length} records`);
    return records;
  }

  async sync(): Promise<SyncResult> {
    const token = await this.generateToken();

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const startDate = addDays(today, -90); // 3 months back
    const chunks = buildChunks(startDate, today, 7);

    console.log(`[PO Sync] Syncing ${chunks.length} weekly chunks from ${fmt(startDate)} to ${fmt(today)}`);

    const allRows: ProductionOrderRow[] = [];
    let fetchFailed = 0;

    for (const chunk of chunks) {
      try {
        const raw = await this.fetchChunk(token, chunk.start, chunk.end);
        for (const record of raw) {
          const normalized = normalizeRow(record);
          if (normalized) allRows.push(normalized);
        }
      } catch (err) {
        console.error(`[PO Sync] Chunk ${chunk.start}→${chunk.end} failed:`, err);
        fetchFailed++;
      }
    }

    console.log(`[PO Sync] Normalized ${allRows.length} rows. Upserting...`);

    const dbResult = await this.repo.upsertOrders(allRows);
    return {
      imported: dbResult.imported,
      updated: dbResult.updated,
      skipped: dbResult.skipped,
      failed: dbResult.failed + fetchFailed,
    };
  }
}
