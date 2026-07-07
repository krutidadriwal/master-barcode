import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseReceivingSheetRepository } from './_lib/SupabaseReceivingSheetRepository.js';
import { SupabaseVendorShipmentRepository } from './_lib/SupabaseVendorShipmentRepository.js';

const receivingSheetRepo = new SupabaseReceivingSheetRepository();
const vendorShipmentRepo = new SupabaseVendorShipmentRepository();

function appScriptForBarcodeEnabled(): boolean {
  return (process.env.APP_SCRIPT_FOR_BARCODE ?? '').trim() === 'true';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  try {

    // POST /api/receiving-sheet/sync — pull the "Purchase Orders" tab from the
    // 'Inventory' Google Sheet (a different spreadsheet from the shipment sync)
    // via Apps Script and upsert into Supabase (inventory_po_lines).
    if (action === 'sync') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

      if (!appScriptForBarcodeEnabled()) {
        return res.status(501).json({
          error: 'Central DB flow for the receiving sheet is not built yet. Set APP_SCRIPT_FOR_BARCODE=true to sync from the Inventory sheet.',
        });
      }

      const scriptUrl = process.env.INVENTORY_SCRIPTS_URL;
      if (!scriptUrl?.trim()) return res.status(503).json({ error: 'INVENTORY_SCRIPTS_URL is not configured.' });

      const r = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_receiving_sheet_data' }),
      });
      if (!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
      const data = await r.json() as any;
      if (!data.success) throw new Error(data.error || data.message || 'Apps Script returned failure');

      const rawLines: any[] = data.lines || [];
      const lines = rawLines
        .filter((l: any) => l['po_id'] && l['item_sku'])
        .map((l: any) => {
          const poId    = String(l['po_id']    || '').trim();
          const itemSku = String(l['item_sku'] || '').trim();
          return {
            line_id:     `${poId}::${itemSku}`,
            po_id:       poId,
            po_ref_no:   String(l['po_ref_no']  || '').trim() || null,
            item_sku:    itemSku,
            ean_fnsku:   String(l['ean_fnsku']  || '').trim() || null,
            item_name:   String(l['item_name']  || itemSku).trim(),
            qty:         parseInt(l['qty'] ?? 0, 10) || 0,
            pending_qty: parseInt(l['pending_qty'] ?? 0, 10) || 0,
            shipment_id: String(l['shipment_id'] || '').trim() || null,
          };
        });

      const count = await receivingSheetRepo.syncLines(lines);
      return res.json({ success: true, lines: count });
    }

    // GET /api/receiving-sheet/lines — all PO lines for the receiving sheet
    if (action === 'lines') {
      if (!appScriptForBarcodeEnabled()) {
        return res.status(501).json({
          error: 'Central DB flow for the receiving sheet is not built yet. Set APP_SCRIPT_FOR_BARCODE=true to use the Inventory sheet flow.',
        });
      }
      const poId = ((req.query.po_id as string) || '').trim();
      const lines = poId
        ? await receivingSheetRepo.getLinesForPO(poId)
        : await receivingSheetRepo.getLines();
      return res.json({ success: true, lines });
    }

    // GET /api/receiving-sheet/search?po_id=|shipment_id=|po_ref_no= — resolve any one
    // identifier into the matching lines + the other two identifiers + the vendor
    // shipment batch_id (looked up via inventory_po_lines.po_ref_no = vendor_shipments.shipment_id).
    if (action === 'search') {
      if (!appScriptForBarcodeEnabled()) {
        return res.status(501).json({
          error: 'Central DB flow for the receiving sheet is not built yet. Set APP_SCRIPT_FOR_BARCODE=true to use the Inventory sheet flow.',
        });
      }
      const poId       = ((req.query.po_id as string)       || '').trim();
      const shipmentId = ((req.query.shipment_id as string) || '').trim();
      const poRefNo     = ((req.query.po_ref_no as string)   || '').trim();

      if (!poId && !shipmentId && !poRefNo) {
        return res.status(400).json({ error: 'One of po_id, shipment_id, or po_ref_no is required.' });
      }

      const lines = poId
        ? await receivingSheetRepo.getLinesByPoId(poId)
        : shipmentId
        ? await receivingSheetRepo.getLinesByShipmentId(shipmentId)
        : await receivingSheetRepo.getLinesByPoRefNo(poRefNo);

      if (!lines.length) {
        return res.json({ success: true, po_id: poId || null, po_ref_no: poRefNo || null, shipment_id: shipmentId || null, batch_id: null, lines: [] });
      }

      const resolvedPoRefNo = lines[0].po_ref_no;
      let batchId: string | null = null;
      if (resolvedPoRefNo) {
        const shipment = await vendorShipmentRepo.getShipmentByShipmentId(resolvedPoRefNo);
        batchId = shipment?.batch_id || null;
      }

      return res.json({
        success:     true,
        po_id:       lines[0].po_id,
        po_ref_no:   resolvedPoRefNo,
        shipment_id: lines[0].shipment_id,
        batch_id:    batchId,
        lines,
      });
    }

    return res.status(404).json({ error: `Unknown receiving-sheet action: ${action}` });
  } catch (err: any) {
    console.error(`[API] receiving-sheet/${action} error:`, err.message);
    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
}
