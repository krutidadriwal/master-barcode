import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ProductionOrderRepository } from './_lib/ProductionOrderRepository.js';
import { ProductionOrderSyncService } from './_lib/ProductionOrderSyncService.js';

const repository = new ProductionOrderRepository();

function deriveStatus(row: { shipped_quantity: number; item_quantity: number; cancelled_quantity: number }): 'Completed' | 'Cancelled' | 'Pending' {
  if (row.cancelled_quantity > 0) return 'Cancelled';
  if (row.shipped_quantity >= row.item_quantity) return 'Completed';
  return 'Pending';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  try {
    // GET /api/production-order/list
    if (action === 'list') {
      const rows = await repository.getAllOrders();
      const orders = rows.map(row => ({
        reference_code: row.reference_code_short,
        reference_code_original: row.reference_code_original,
        import_date: row.import_date,
        sku: row.sku,
        product_name: row.product_name,
        brand: row.brand,
        order_qty: row.order_quantity,
        shipped_qty: row.shipped_quantity,
        cancelled_qty: row.cancelled_quantity,
        item_qty: row.item_quantity,
        ean: row.ean,
        size: row.size,
        model_no: row.model_no,
        status: deriveStatus(row),
      }));
      return res.json(orders);
    }

    // GET /api/production-order/search?code=...
    if (action === 'search') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
      const code = (req.query.code || '').toString().trim();
      if (!code) return res.status(400).json({ error: 'code query parameter is required.' });
      const rows = await repository.searchByShortCode(code);
      return res.json(rows);
    }

    // POST /api/production-order/sync
    if (action === 'sync') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const syncService = new ProductionOrderSyncService();
      const result = await syncService.sync();
      return res.json({ success: true, ...result });
    }

    // POST /api/production-order/update-match
    if (action === 'update-match') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { id, user_sku, row_sku } = req.body;
      if (!id || user_sku === undefined || !row_sku) {
        return res.status(400).json({ error: 'id, user_sku, and row_sku are required.' });
      }
      const codeMatch = user_sku.toString().trim().toLowerCase() === row_sku.toString().trim().toLowerCase();
      await repository.updateCodeMatch(Number(id), codeMatch);
      return res.json({ code_match: codeMatch });
    }

    return res.status(404).json({ error: `Unknown production-order action: ${action}` });
  } catch (error: any) {
    console.error(`[API] production-order/${action} error:`, error);
    return res.status(500).json({ error: error.message || 'Internal server error.' });
  }
}
