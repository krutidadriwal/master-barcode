import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ProductionOrderSyncService } from '../_lib/ProductionOrderSyncService.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const syncService = new ProductionOrderSyncService();
    const result = await syncService.sync();
    return res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[API] Production order sync error:', error);
    return res.status(500).json({ error: error.message || 'Failed to sync production orders from EasyEcom.' });
  }
}
