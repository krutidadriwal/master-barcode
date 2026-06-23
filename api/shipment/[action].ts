import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseProductRepository } from '../_lib/SupabaseProductRepository.js';
import { SupabaseShipmentRepository } from '../_lib/SupabaseShipmentRepository.js';
import { SupabasePurchaseOrderRepository } from '../_lib/SupabasePurchaseOrderRepository.js';

const repository = new SupabaseProductRepository();
const shipmentRepository = new SupabaseShipmentRepository();
const poRepository = new SupabasePurchaseOrderRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  try {
    // GET /api/shipment/list
    if (action === 'list') {
      const raw = ((req.query.mode as string) || 'AIR').toUpperCase();
      const mode = (raw === 'SEA' ? 'SEA' : 'AIR') as 'AIR' | 'SEA';
      const items = await shipmentRepository.getAllShipments(mode);
      return res.json(items);
    }

    // POST /api/shipment/reset
    if (action === 'reset') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { planned_mode } = req.body || {};
      const mode: 'AIR' | 'SEA' =
        (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';
      await shipmentRepository.resetShipments(mode);
      return res.json({ success: true, message: `${mode} shipment barcodes wiped successfully.` });
    }

    // POST /api/shipment/confirm
    if (action === 'confirm') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { countingQty, planned_mode } = req.body;
      if (!countingQty || typeof countingQty !== 'object') {
        return res.status(400).json({ error: 'countingQty must be a key-value object of scanned counts.' });
      }
      const mode: 'AIR' | 'SEA' =
        (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';
      const allProducts = await repository.getAllProducts();
      for (const [sku, counted] of Object.entries(countingQty)) {
        if (typeof counted !== 'number' || counted <= 0) continue;
        const prod = allProducts.find(p => p.sku && p.sku.toLowerCase() === sku.toLowerCase());
        const name = prod ? prod.product_name : `Unexpected SKU ${sku}`;
        const prodId = prod ? prod.product_id : null;
        await shipmentRepository.incrementFulfilledQty(sku, name, prodId, counted, mode);
      }
      return res.json({ success: true });
    }

    // POST /api/shipment/sync  (legacy AIR/SEA shipment sync)
    if (action === 'sync') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { demo } = req.body || {};
      let rawData: any[] = [];
      if (!demo) {
        const scriptUrl = process.env.APP_SCRIPTS_URL;
        if (!scriptUrl?.trim()) throw new Error('APP_SCRIPTS_URL is not set in environment variables.');
        const response = await fetch(scriptUrl);
        if (!response.ok) throw new Error(`Google Apps Script responded with status: ${response.status}`);
        rawData = await response.json();
        if (!Array.isArray(rawData)) throw new Error('Apps Script response is not a JSON array.');
      } else {
        const allProducts = await repository.getAllProducts();
        rawData = allProducts.slice(0, 4).map((p, index) => {
          const ordered = (index + 2) * 15;
          const fulfilled = (index + 1) * 6;
          return { sku: p.sku, sku_name: p.product_name, ordered_qty: ordered, fulfilled_qty: fulfilled };
        });
      }
      const aggregated: Record<string, { sku: string; planned_mode: 'AIR' | 'SEA'; sku_name: string; ordered_qty: number; fulfilled_qty: number; product_id?: string }> = {};
      for (const row of rawData) {
        const sku = (row.sku || '').toString().trim();
        if (!sku) continue;
        const rawMode = (row.planned_mode || 'AIR').toString().trim().toUpperCase();
        const planned_mode: 'AIR' | 'SEA' = rawMode === 'SEA' ? 'SEA' : 'AIR';
        const key = `${sku}|${planned_mode}`;
        const ordered = parseInt(row.ordered_qty, 10) || 0;
        const fulfilled = parseInt(row.fulfilled_qty, 10) || 0;
        const name = (row.sku_name || row.item_name || 'Unnamed Product').toString().trim();
        if (aggregated[key]) {
          aggregated[key].ordered_qty += ordered;
          aggregated[key].fulfilled_qty += fulfilled;
          if (!aggregated[key].sku_name || aggregated[key].sku_name === 'Unnamed Product') aggregated[key].sku_name = name;
        } else {
          aggregated[key] = { sku, planned_mode, sku_name: name, ordered_qty: ordered, fulfilled_qty: fulfilled };
        }
      }
      const products = await repository.getAllProducts();
      for (const key in aggregated) {
        const { sku } = aggregated[key];
        const match = products.find(p => p.sku && p.sku.toLowerCase() === sku.toLowerCase());
        if (match) aggregated[key].product_id = match.product_id;
      }
      const itemsToUpsert = Object.values(aggregated).map(item => ({
        sku: item.sku, planned_mode: item.planned_mode, product_id: item.product_id,
        sku_name: item.sku_name, cu_ordered_qty: item.ordered_qty, fulfilled_qty: 0,
      }));
      const upserted = await shipmentRepository.upsertShipmentItems(itemsToUpsert);
      return res.json({ success: true, count: upserted.length, data: upserted });
    }

    // GET /api/shipment/po-ref-nums
    if (action === 'po-ref-nums') {
      const refNums = await poRepository.getDistinctPORefNums();
      return res.json(refNums);
    }

    // GET /api/shipment/po-lines?po_ref_num=...
    if (action === 'po-lines') {
      const poRefNum = ((req.query.po_ref_num as string) || '').trim();
      if (!poRefNum) return res.status(400).json({ error: 'po_ref_num query parameter is required.' });
      const lines = await poRepository.getPOLinesByRefNum(poRefNum);
      return res.json(lines);
    }

    // POST /api/shipment/po-sync
    if (action === 'po-sync') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { demo } = req.body || {};
      let headersRaw: any[] = [];
      let linesRaw: any[] = [];

      if (!demo) {
        const scriptUrl = process.env.PO_SCRIPTS_URL;
        if (!scriptUrl?.trim()) throw new Error('PO_SCRIPTS_URL is not set in environment.');
        console.log('[PO Sync] Fetching Apps Script URL:', scriptUrl.slice(0, 60) + '...');
        const response = await fetch(scriptUrl, { redirect: 'follow' });
        console.log('[PO Sync] Apps Script HTTP status:', response.status, response.statusText);
        const rawText = await response.text();
        console.log('[PO Sync] Apps Script raw response (first 500 chars):', rawText.slice(0, 500));
        if (!response.ok) throw new Error(`Apps Script responded with HTTP ${response.status}: ${rawText.slice(0, 200)}`);
        let data: any;
        try { data = JSON.parse(rawText); } catch { throw new Error(`Apps Script response is not valid JSON. Got: ${rawText.slice(0, 200)}`); }
        if (data?.error) throw new Error(`Apps Script error: ${data.message || JSON.stringify(data)}`);
        headersRaw = Array.isArray(data.headers) ? data.headers : [];
        linesRaw   = Array.isArray(data.lines)   ? data.lines   : [];
        console.log(`[PO Sync] Parsed — headers: ${headersRaw.length}, lines: ${linesRaw.length}`);
      } else {
        headersRaw = [
          { po_id: 'PO-DEMO-001', po_ref_num: '24134-YJ',      vendor_name: 'Demo Vendor A', vendor_code: 'V001', po_status_id: '1', total_po_value: 15000, po_created_date: '2025-01-15', po_updated_date: '2025-01-20' },
          { po_id: 'PO-DEMO-002', po_ref_num: 'VS-PW260515-1', vendor_name: 'Demo Vendor B', vendor_code: 'V002', po_status_id: '1', total_po_value: 8500,  po_created_date: '2025-02-01', po_updated_date: '2025-02-05' },
          { po_id: 'PO-DEMO-003', po_ref_num: '24119-PW',       vendor_name: 'Demo Vendor C', vendor_code: 'V003', po_status_id: '2', total_po_value: 22000, po_created_date: '2025-03-10', po_updated_date: '2025-03-12' },
        ];
        const allProducts = await repository.getAllProducts();
        const sample = allProducts.slice(0, 9);
        const refNums = ['24134-YJ', 'VS-PW260515-1', '24119-PW'];
        const poIds   = ['PO-DEMO-001', 'PO-DEMO-002', 'PO-DEMO-003'];
        linesRaw = sample.map((p, i) => ({
          po_ref_num: refNums[Math.floor(i / 3)], po_id: poIds[Math.floor(i / 3)],
          sku: p.sku, original_quantity: (i % 3 + 2) * 10, pending_quantity: (i % 3 + 2) * 10, item_price: 99.99,
        }));
      }

      const headers = headersRaw.map((h: any) => ({
        po_id:           String(h.po_id           || '').trim(),
        po_ref_num:      String(h.po_ref_num      || '').trim(),
        total_po_value:  h.total_po_value  != null ? parseFloat(h.total_po_value)  : undefined,
        po_status_id:    h.po_status_id    != null ? String(h.po_status_id).trim()  : undefined,
        po_created_date: h.po_created_date != null ? String(h.po_created_date).trim(): undefined,
        po_updated_date: h.po_updated_date != null ? String(h.po_updated_date).trim(): undefined,
        vendor_name:     h.vendor_name     != null ? String(h.vendor_name).trim()    : undefined,
        vendor_code:     h.vendor_code     != null ? String(h.vendor_code).trim()    : undefined,
      })).filter((h: any) => h.po_id && h.po_ref_num);

      const lines = linesRaw.map((l: any) => ({
        po_ref_num:        String(l.po_ref_num || '').trim(),
        po_id:             l.po_id != null ? String(l.po_id).trim() : undefined,
        sku:               String(l.sku || '').trim(),
        original_quantity: parseInt(l.original_quantity, 10) || 0,
        pending_quantity:  parseInt(l.pending_quantity ?? l.original_quantity, 10) || 0,
        item_price:        l.item_price != null ? parseFloat(l.item_price) : undefined,
      })).filter((l: any) => l.po_ref_num && l.sku);

      console.log(`[PO Sync] After mapping+filter — headers: ${headers.length}, lines: ${lines.length}`);
      if (headers.length === 0) console.warn('[PO Sync] WARNING: 0 headers. Check po_id/po_ref_num columns.');
      if (lines.length === 0)   console.warn('[PO Sync] WARNING: 0 lines. Check sku/po_ref_num columns.');

      const headerResult = await poRepository.upsertPOHeaders(headers);
      const linesResult  = await poRepository.upsertPOLines(lines);
      return res.json({
        success: true,
        headersInserted: headerResult.inserted, headersUpdated: headerResult.updated,
        linesInserted: linesResult.inserted,   linesUpdated:  linesResult.updated,
      });
    }

    return res.status(404).json({ error: `Unknown shipment action: ${action}` });
  } catch (err: any) {
    console.error(`[API] shipment/${action} error:`, err.message);
    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
}
