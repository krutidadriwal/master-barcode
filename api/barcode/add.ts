import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseProductRepository } from '../_lib/SupabaseProductRepository.js';

const repository = new SupabaseProductRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { sku, item_name, mrp, ean_upc, batch_no } = req.body;
    if (!sku || !item_name || !mrp || !ean_upc) {
      return res.status(400).json({ error: 'sku, item_name, mrp, and ean_upc are all required.' });
    }

    const product = await repository.addProduct({ sku, item_name, mrp, ean_upc, batch_no });
    return res.status(201).json(product);
  } catch (error) {
    console.error('[API] Add product error:', error);
    return res.status(500).json({ error: 'Failed to record custom product in repository.' });
  }
}
