import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ProductionOrderRepository } from '../_lib/ProductionOrderRepository.js';

const repository = new ProductionOrderRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const code = (req.query.code || '').toString().trim();
  if (!code) return res.status(400).json({ error: 'code query parameter is required.' });

  try {
    const rows = await repository.searchByShortCode(code);
    return res.json(rows);
  } catch (error: any) {
    console.error('[API] Production order search error:', error);
    return res.status(500).json({ error: error.message || 'Failed to search production orders.' });
  }
}
