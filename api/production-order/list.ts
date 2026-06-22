import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ProductionOrderRepository } from '../_lib/ProductionOrderRepository.js';

const repository = new ProductionOrderRepository();

function deriveStatus(row: {
  shipped_quantity: number;
  item_quantity: number;
  cancelled_quantity: number;
}): 'Completed' | 'Cancelled' | 'Pending' {
  if (row.cancelled_quantity > 0) return 'Cancelled';
  if (row.shipped_quantity >= row.item_quantity) return 'Completed';
  return 'Pending';
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
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
  } catch (error: any) {
    console.error('[API] Production order list error:', error);
    return res.status(500).json({ error: error.message || 'Failed to retrieve production orders.' });
  }
}
