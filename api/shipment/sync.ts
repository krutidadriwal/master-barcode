import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseProductRepository } from '../../src/shared/repositories/SupabaseProductRepository';
import { SupabaseShipmentRepository } from '../../src/shared/repositories/SupabaseShipmentRepository';

const repository = new SupabaseProductRepository();
const shipmentRepository = new SupabaseShipmentRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { demo } = req.body || {};
    let rawData: any[] = [];

    if (!demo) {
      const scriptUrl = process.env.APP_SCRIPTS_URL;
      if (!scriptUrl || !scriptUrl.trim()) {
        throw new Error('APP_SCRIPTS_URL is not set in environment variables.');
      }
      console.log(`[Shipment Sync] Fetching from Apps Script: ${scriptUrl}`);
      const response = await fetch(scriptUrl);
      if (!response.ok) {
        throw new Error(`Google Apps Script responded with status: ${response.status}`);
      }
      rawData = await response.json();
      if (!Array.isArray(rawData)) {
        throw new Error('Apps Script response is not a JSON array.');
      }
    } else {
      const allProducts = await repository.getAllProducts();
      if (allProducts && allProducts.length > 0) {
        rawData = allProducts.slice(0, 4).map((p, index) => {
          const ordered = (index + 2) * 15;
          const fulfilled = (index + 1) * 6;
          return { sku: p.sku, sku_name: p.item_name, ordered_qty: ordered, fulfilled_qty: fulfilled };
        });
      } else {
        rawData = [
          { sku: '1020137', sku_name: 'QiYi MP 2x2 M Stickerless',       ordered_qty: 50, fulfilled_qty: 15 },
          { sku: '1020080', sku_name: 'QiYi QiDi S 2x2 Stickerless',     ordered_qty: 25, fulfilled_qty: 5  },
          { sku: '1030405', sku_name: 'MoYu MeiLong 3C 3x3 Stickerless', ordered_qty: 100, fulfilled_qty: 20 }
        ];
      }
    }

    // Aggregate by (sku, planned_mode)
    const aggregated: {
      [key: string]: {
        sku: string;
        planned_mode: 'AIR' | 'SEA';
        sku_name: string;
        ordered_qty: number;
        fulfilled_qty: number;
        product_id?: string;
      };
    } = {};

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
        if (!aggregated[key].sku_name || aggregated[key].sku_name === 'Unnamed Product') {
          aggregated[key].sku_name = name;
        }
      } else {
        aggregated[key] = { sku, planned_mode, sku_name: name, ordered_qty: ordered, fulfilled_qty: fulfilled };
      }
    }

    // Match product_ids from the product table
    const products = await repository.getAllProducts();
    for (const key in aggregated) {
      const { sku } = aggregated[key];
      const match = products.find(p => p.sku && p.sku.toLowerCase() === sku.toLowerCase());
      if (match) aggregated[key].product_id = match.product_id;
    }

    const itemsToUpsert = Object.values(aggregated).map(item => ({
      sku:           item.sku,
      planned_mode:  item.planned_mode,
      product_id:    item.product_id,
      sku_name:      item.sku_name,
      cu_ordered_qty: item.ordered_qty,
      fulfilled_qty:  0  // managed by Supabase only via Confirm Session
    }));

    const upserted = await shipmentRepository.upsertShipmentItems(itemsToUpsert);
    return res.json({ success: true, count: upserted.length, data: upserted });
  } catch (error: any) {
    console.error('[Shipment Sync] Sync error:', error);
    return res.status(500).json({ error: error.message || 'Failed to sync Google Sheet shipment data.' });
  }
}
