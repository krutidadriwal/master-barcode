import type { VercelRequest, VercelResponse } from '@vercel/node';
import { EasyEcomProductMasterSyncService } from './_lib/EasyEcomProductMasterSyncService.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  try {
    // POST /api/product-master/sync — sync product master from the central
    // EasyEcomProductMaster database. Requires CENTRAL_DB_URL and DATABASE_URL.
    if (action === 'sync') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

      const syncService = new EasyEcomProductMasterSyncService();
      const result = await syncService.sync();
      await syncService.close();
      return res.json({ success: true, ...result });
    }

    return res.status(404).json({ error: `Unknown action: ${action}` });
  } catch (err: any) {
    console.error('[API Product Master Sync] Failed:', err);
    return res.status(500).json({ error: err.message || 'Product master sync failed.' });
  }
}
