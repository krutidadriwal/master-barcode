import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseProductRepository } from './_lib/SupabaseProductRepository.js';

const repository = new SupabaseProductRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  try {
    // POST /api/barcode/search
    if (action === 'search') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { identifier } = req.body;
      if (!identifier) return res.status(400).json({ error: 'Identifier parameter is required.' });
      const product = await repository.searchProduct(identifier);
      if (!product) return res.status(404).json({ error: 'Product not found.' });
      return res.json(product);
    }

    // GET /api/barcode/products
    if (action === 'products') {
      const products = await repository.getAllProducts();
      return res.json(products);
    }

    // POST /api/barcode/add
    if (action === 'add') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { sku, item_name, mrp, ean_upc, batch_no } = req.body;
      if (!sku || !item_name || !mrp || !ean_upc) {
        return res.status(400).json({ error: 'sku, item_name, mrp, and ean_upc are all required.' });
      }
      const product = await repository.addProduct({ sku, item_name, mrp, ean_upc, batch_no });
      return res.status(201).json(product);
    }

    return res.status(404).json({ error: `Unknown barcode action: ${action}` });
  } catch (error: any) {
    console.error(`[API] barcode/${action} error:`, error);
    return res.status(500).json({ error: error.message || 'Internal server error.' });
  }
}
