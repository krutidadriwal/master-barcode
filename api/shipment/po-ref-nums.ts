import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabasePurchaseOrderRepository } from '../_lib/SupabasePurchaseOrderRepository';

const poRepository = new SupabasePurchaseOrderRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const refNums = await poRepository.getDistinctPORefNums();
    return res.json(refNums);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch PO ref nums.' });
  }
}
