import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseProductRepository } from '../_lib/SupabaseProductRepository.js';
import { SupabaseShipmentRepository } from '../_lib/SupabaseShipmentRepository.js';

const repository = new SupabaseProductRepository();
const shipmentRepository = new SupabaseShipmentRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
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
      const name = prod ? prod.item_name : `Unexpected SKU ${sku}`;
      const prodId = prod ? prod.product_id : null;

      await shipmentRepository.incrementFulfilledQty(sku, name, prodId, counted, mode);
    }

    return res.json({ success: true });
  } catch (error: any) {
    console.error('[API] Session confirmation error:', error);
    return res.status(500).json({ error: error.message || 'Failed to record session quantities into shipment rows.' });
  }
}
