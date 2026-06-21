import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseProductRepository } from '../_lib/SupabaseProductRepository.js';

const repository = new SupabaseProductRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: 'Identifier parameter is required.' });

    const product = await repository.searchProduct(identifier);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    return res.json(product);
  } catch (error: any) {
    console.error('[API] Search error:', error);
    return res.status(500).json({ error: 'Internal failure searching database repository.' });
  }
}
