import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseProductRepository } from './_lib/SupabaseProductRepository.js';
import { SupabaseShipmentRepository } from './_lib/SupabaseShipmentRepository.js';
import { SupabasePurchaseOrderRepository } from './_lib/SupabasePurchaseOrderRepository.js';
import { SupabaseVendorShipmentRepository } from './_lib/SupabaseVendorShipmentRepository.js';

const repository = new SupabaseProductRepository();
const shipmentRepository = new SupabaseShipmentRepository();
const poRepository = new SupabasePurchaseOrderRepository();
const vendorShipmentRepo = new SupabaseVendorShipmentRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  try {

    // ── Vendor Shipment Barcode routes ────────────────────────────────────────

    // POST /api/shipment/sync — pull Batches, Vendor_Shipments, Vendor_Shipment_Lines from
    // Google Sheets via Apps Script and upsert into Supabase. scanned_quantity is preserved.
    if (action === 'sync') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const scriptUrl = process.env.APP_SCRIPTS_URL;
      if (!scriptUrl?.trim()) return res.status(503).json({ error: 'APP_SCRIPTS_URL is not configured.' });

      const r = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_shipment_data' }),
      });
      if (!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
      const data = await r.json() as any;
      if (!data.success) throw new Error(data.error || data.message || 'Apps Script returned failure');

      const rawBatches:   any[] = data.batches   || [];
      const rawShipments: any[] = data.shipments  || [];
      const rawLines:     any[] = data.lines      || [];

      const batches = rawBatches
        .filter((b: any) => b['batch_id'])
        .map((b: any) => ({
          batch_id:          String(b['batch_id']          || '').trim(),
          status:            String(b['status']            || '').trim() || null,
          expected_delivery: String(b['expected_delivery'] || '').trim() || null,
          actual_delivery:   String(b['actual_delivery']   || '').trim() || null,
          carrier:           String(b['carrier']           || '').trim() || null,
          remarks:           String(b['remarks']           || '').trim() || null,
        }));

      const shipments = rawShipments
        .filter((s: any) => s['shipment_id'])
        .map((s: any) => ({
          shipment_id:  String(s['shipment_id']  || '').trim(),
          batch_id:     String(s['batch_id']     || '').trim(),
          vendor_code:  String(s['vendor_code']  || '').trim() || null,
          invoice_no:   String(s['invoice_no']   || '').trim() || null,
          invoice_date: String(s['invoice_date'] || '').trim() || null,
          carton_count: parseInt(s['carton_count'] || 0, 10) || 0,
          total_units:  0, // computed below from lines
        }));

      const lines = rawLines
        .filter((l: any) => l['shipment_id'] && l['sku'])
        .map((l: any) => {
          const shipmentId  = String(l['shipment_id'] || '').trim();
          const sku         = String(l['sku']         || '').trim();
          return {
            line_id:          `${shipmentId}::${sku}`,
            shipment_id:      shipmentId,
            batch_id:         String(l['batch_id']    || '').trim(),
            vendor_code:      String(l['vendor_code'] || '').trim() || null,
            sku,
            item_name:        String(l['item_name']   || sku).trim(),
            ean:              String(l['ean']         || '').trim() || null,
            incoming_qty:     parseInt(l['invoice_qty'] ?? l['qty'] ?? l['invoice_quantity'] ?? 0, 10) || 0,
            scanned_quantity: 0, // never read from sheet — preserved in DB by syncLines
          };
        });

      const unitsByShipment: Record<string, number> = {};
      for (const l of lines) unitsByShipment[l.shipment_id] = (unitsByShipment[l.shipment_id] || 0) + l.incoming_qty;
      for (const s of shipments) s.total_units = unitsByShipment[s.shipment_id] || 0;

      const bCount = await vendorShipmentRepo.syncBatches(batches);
      const sCount = await vendorShipmentRepo.syncShipments(shipments);
      const lCount = await vendorShipmentRepo.syncLines(lines);

      return res.json({ success: true, batches: bCount, shipments: sCount, lines: lCount });
    }

    // GET /api/shipment/batches — list all batches with summary fields
    if (action === 'batches') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
      const batches   = await vendorShipmentRepo.getBatches();
      const shipments = await Promise.all(
        batches.map(b => vendorShipmentRepo.getShipmentsForBatch(b.batch_id))
      );
      const result = batches.map((b, i) => {
        const batchShipments = shipments[i];
        const batchId        = b.batch_id;
        const batchType      = batchId.toUpperCase().startsWith('A') ? 'air' : 'sea';
        const totalUnits     = batchShipments.reduce((sum, s) => sum + (s.total_units  || 0), 0);
        const totalCartons   = batchShipments.reduce((sum, s) => sum + (s.carton_count || 0), 0);
        return {
          batch_id:          batchId,
          batch_type:        batchType,
          status:            b.status || 'unknown',
          total_shipments:   batchShipments.length,
          total_cartons:     totalCartons,
          total_units:       totalUnits,
          expected_delivery: b.expected_delivery || null,
          actual_delivery:   b.actual_delivery   || null,
          carrier:           b.carrier || null,
          is_delayed:        false,
          delay_days:        0,
          vendor_summary:    batchShipments.map(s => ({
            vendor_code:  s.vendor_code,
            shipment_id:  s.shipment_id,
            carton_count: s.carton_count,
            invoice_no:   s.invoice_no,
            invoice_date: s.invoice_date,
            total_units:  s.total_units,
          })),
        };
      });
      return res.json(result);
    }

    // GET /api/shipment/batch-detail?batch_id=... — shipments + line items with scanned_quantity
    if (action === 'batch-detail') {
      const batchId = ((req.query.batch_id as string) || '').trim();
      if (!batchId) return res.status(400).json({ error: 'batch_id is required.' });
      const [shipments, lines] = await Promise.all([
        vendorShipmentRepo.getShipmentsForBatch(batchId),
        vendorShipmentRepo.getLinesForBatch(batchId),
      ]);
      const linesByShipment: Record<string, typeof lines> = {};
      for (const l of lines) {
        if (!linesByShipment[l.shipment_id]) linesByShipment[l.shipment_id] = [];
        linesByShipment[l.shipment_id].push(l);
      }
      const batchType = batchId.toUpperCase().startsWith('A') ? 'air' : 'sea';
      const batch = {
        batch_id:         batchId,
        batch_type:       batchType,
        status:           shipments.length ? 'open' : 'unknown',
        vendor_shipments: shipments.map(s => ({
          shipment_id:  s.shipment_id,
          vendor_code:  s.vendor_code,
          vendor_name:  s.vendor_code,
          invoice_no:   s.invoice_no,
          total_units:  s.total_units,
          carton_count: s.carton_count,
          line_items:   (linesByShipment[s.shipment_id] || []).map(l => ({
            line_id:          l.line_id,
            sku:              l.sku,
            item_name:        l.item_name,
            ean:              l.ean,
            incoming_qty:     l.incoming_qty,
            scanned_quantity: l.scanned_quantity,
          })),
        })),
      };
      return res.json({ batch });
    }

    // POST /api/shipment/scan-line — increment scanned_quantity by 1 for a line
    if (action === 'scan-line') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { line_id } = req.body;
      if (!line_id) return res.status(400).json({ error: 'line_id is required.' });
      await vendorShipmentRepo.incrementScannedQty(line_id);
      return res.json({ success: true });
    }

    // POST /api/shipment/writeback — push scanned_quantity values back to the Google Sheet
    if (action === 'writeback') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const scriptUrl = process.env.APP_SCRIPTS_URL;
      if (!scriptUrl?.trim()) return res.status(503).json({ error: 'APP_SCRIPTS_URL not configured.' });
      const updates = await vendorShipmentRepo.getScannedQuantitiesForWriteback();
      if (!updates.length) return res.json({ success: true, updated: 0 });
      const r = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_scanned_quantities', updates }),
      });
      if (!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
      const data = await r.json() as any;
      if (!data.success) throw new Error(data.error || 'Apps Script writeback failed');
      return res.json({ success: true, updated: data.updated });
    }

    // GET /api/shipment/sync-debug — raw Apps Script response without touching Supabase
    if (action === 'sync-debug') {
      const scriptUrl = process.env.APP_SCRIPTS_URL;
      if (!scriptUrl?.trim()) return res.status(503).json({ error: 'APP_SCRIPTS_URL not configured.' });
      const r = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_shipment_data' }),
      });
      const data = await r.json() as any;
      const firstBatch    = (data.batches   || [])[0] || null;
      const firstShipment = (data.shipments || [])[0] || null;
      const firstLine     = (data.lines     || [])[0] || null;
      return res.json({
        counts:        { batches: data.batches?.length, shipments: data.shipments?.length, lines: data.lines?.length },
        sample_batch:    firstBatch,
        sample_shipment: firstShipment,
        sample_line:     firstLine,
        batch_keys:    firstBatch    ? Object.keys(firstBatch)    : [],
        shipment_keys: firstShipment ? Object.keys(firstShipment) : [],
        line_keys:     firstLine     ? Object.keys(firstLine)     : [],
      });
    }

    // ── Purchase Order routes ─────────────────────────────────────────────────

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
        const response = await fetch(scriptUrl, { redirect: 'follow' });
        const rawText = await response.text();
        if (!response.ok) throw new Error(`Apps Script responded with HTTP ${response.status}: ${rawText.slice(0, 200)}`);
        let data: any;
        try { data = JSON.parse(rawText); } catch { throw new Error(`Apps Script response is not valid JSON. Got: ${rawText.slice(0, 200)}`); }
        if (data?.error) throw new Error(`Apps Script error: ${data.message || JSON.stringify(data)}`);
        headersRaw = Array.isArray(data.headers) ? data.headers : [];
        linesRaw   = Array.isArray(data.lines)   ? data.lines   : [];
      } else {
        headersRaw = [
          { po_id: 'PO-DEMO-001', po_ref_num: '24134-YJ',      vendor_name: 'Demo Vendor A', vendor_code: 'V001', po_status_id: '1', total_po_value: 15000, po_created_date: '2025-01-15', po_updated_date: '2025-01-20' },
          { po_id: 'PO-DEMO-002', po_ref_num: 'VS-PW260515-1', vendor_name: 'Demo Vendor B', vendor_code: 'V002', po_status_id: '1', total_po_value: 8500,  po_created_date: '2025-02-01', po_updated_date: '2025-02-05' },
          { po_id: 'PO-DEMO-003', po_ref_num: '24119-PW',       vendor_name: 'Demo Vendor C', vendor_code: 'V003', po_status_id: '2', total_po_value: 22000, po_created_date: '2025-03-10', po_updated_date: '2025-03-12' },
        ];
        const allProducts = await repository.getAllProducts();
        const sample  = allProducts.slice(0, 9);
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
        total_po_value:  h.total_po_value  != null ? parseFloat(h.total_po_value)   : undefined,
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

      const headerResult = await poRepository.upsertPOHeaders(headers);
      const linesResult  = await poRepository.upsertPOLines(lines);
      return res.json({
        success: true,
        headersInserted: headerResult.inserted, headersUpdated: headerResult.updated,
        linesInserted:   linesResult.inserted,  linesUpdated:   linesResult.updated,
      });
    }

    // ── Legacy AIR/SEA shipment routes (kept for backward compat) ─────────────

    if (action === 'list') {
      const raw  = ((req.query.mode as string) || 'AIR').toUpperCase();
      const mode = (raw === 'SEA' ? 'SEA' : 'AIR') as 'AIR' | 'SEA';
      const items = await shipmentRepository.getAllShipments(mode);
      return res.json(items);
    }

    if (action === 'reset') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { planned_mode } = req.body || {};
      const mode: 'AIR' | 'SEA' = (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';
      await shipmentRepository.resetShipments(mode);
      return res.json({ success: true, message: `${mode} shipment barcodes wiped successfully.` });
    }

    if (action === 'confirm') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { countingQty, planned_mode } = req.body;
      if (!countingQty || typeof countingQty !== 'object') {
        return res.status(400).json({ error: 'countingQty must be a key-value object of scanned counts.' });
      }
      const mode: 'AIR' | 'SEA' = (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';
      const allProducts = await repository.getAllProducts();
      for (const [sku, counted] of Object.entries(countingQty)) {
        if (typeof counted !== 'number' || counted <= 0) continue;
        const prod   = allProducts.find(p => p.sku && p.sku.toLowerCase() === sku.toLowerCase());
        const name   = prod ? prod.product_name : `Unexpected SKU ${sku}`;
        const prodId = prod ? prod.product_id : null;
        await shipmentRepository.incrementFulfilledQty(sku, name, prodId, counted, mode);
      }
      return res.json({ success: true });
    }

    return res.status(404).json({ error: `Unknown shipment action: ${action}` });
  } catch (err: any) {
    console.error(`[API] shipment/${action} error:`, err.message);
    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
}
