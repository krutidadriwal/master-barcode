import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseShipmentRepository } from '../_lib/SupabaseShipmentRepository.js';

const shipmentRepository = new SupabaseShipmentRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { planned_mode } = req.body || {};
    const mode: 'AIR' | 'SEA' =
      (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';
    await shipmentRepository.resetShipments(mode);
    return res.json({ success: true, message: `${mode} shipment barcodes wiped successfully.` });
  } catch (error: any) {
    console.error('[API] Reset shipment error:', error);
    return res.status(500).json({ error: 'Failed to reset shipments table.' });
  }
}
