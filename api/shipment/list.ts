import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseShipmentRepository } from '../_lib/SupabaseShipmentRepository';

const shipmentRepository = new SupabaseShipmentRepository();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const raw = ((req.query.mode as string) || 'AIR').toUpperCase();
    const mode = (raw === 'SEA' ? 'SEA' : 'AIR') as 'AIR' | 'SEA';
    const items = await shipmentRepository.getAllShipments(mode);
    return res.json(items);
  } catch (error: any) {
    console.error('[API] Get shipment list error:', error);
    return res.status(500).json({ error: 'Failed to retrieve shipment inventory.' });
  }
}
