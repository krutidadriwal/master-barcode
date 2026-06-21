import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseProductRepository } from '../_lib/SupabaseProductRepository.js';

const repository = new SupabaseProductRepository();

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const products = await repository.getAllProducts();
    return res.json(products);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to retrieve products list.' });
  }
}
