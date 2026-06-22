import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ProductionOrderRepository } from '../_lib/ProductionOrderRepository';

const repository = new ProductionOrderRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { id, user_sku, row_sku } = req.body;
  if (!id || user_sku === undefined || !row_sku) {
    return res.status(400).json({ error: 'id, user_sku, and row_sku are required.' });
  }

  const codeMatch = user_sku.toString().trim().toLowerCase() === row_sku.toString().trim().toLowerCase();

  try {
    await repository.updateCodeMatch(Number(id), codeMatch);
    return res.json({ code_match: codeMatch });
  } catch (error: any) {
    console.error('[API] update-match error:', error);
    return res.status(500).json({ error: error.message || 'Failed to update code match.' });
  }
}
