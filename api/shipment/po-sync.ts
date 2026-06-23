import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabasePurchaseOrderRepository } from '../_lib/SupabasePurchaseOrderRepository';
import { SupabaseProductRepository } from '../_lib/SupabaseProductRepository';

const poRepository = new SupabasePurchaseOrderRepository();
const repository = new SupabaseProductRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
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
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`Apps Script response is not valid JSON. Got: ${rawText.slice(0, 200)}`);
      }
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
        po_ref_num: refNums[Math.floor(i / 3)],
        po_id:      poIds[Math.floor(i / 3)],
        sku: p.sku,
        original_quantity: (i % 3 + 2) * 10,
        pending_quantity:  (i % 3 + 2) * 10,
        item_price: 99.99,
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
      headersInserted: headerResult.inserted,
      headersUpdated:  headerResult.updated,
      linesInserted:   linesResult.inserted,
      linesUpdated:    linesResult.updated,
    });
  } catch (err: any) {
    console.error('[PO Sync] FAILED:', err.message);
    return res.status(500).json({ error: err.message || 'Purchase order sync failed.' });
  }
}
