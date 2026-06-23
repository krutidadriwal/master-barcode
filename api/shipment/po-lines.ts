import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabasePurchaseOrderRepository } from '../_lib/SupabasePurchaseOrderRepository';

const poRepository = new SupabasePurchaseOrderRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const poRefNum = ((req.query.po_ref_num as string) || '').trim();
    if (!poRefNum) return res.status(400).json({ error: 'po_ref_num query parameter is required.' });
    const lines = await poRepository.getPOLinesByRefNum(poRefNum);
    return res.json(lines);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch PO lines.' });
  }
}
