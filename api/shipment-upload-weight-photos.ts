import type { VercelRequest, VercelResponse } from '@vercel/node';
import multer from 'multer';
import { SupabaseVendorShipmentRepository } from './_lib/SupabaseVendorShipmentRepository.js';
import { GoogleDriveService } from './_lib/GoogleDriveService.js';

// Multipart bodies must reach multer unparsed — this file is isolated from the
// shared api/shipment.ts catch-all specifically so disabling Vercel's automatic
// body parser here doesn't affect that file's JSON-based actions.
export const config = {
  api: { bodyParser: false },
};

const vendorShipmentRepo = new SupabaseVendorShipmentRepository();
const googleDriveService = new GoogleDriveService();
// Vercel hard-caps the total serverless request body at ~4.5MB regardless of
// plan — this is enforced by the platform before our code runs, so multer's
// own limit must stay well under that for 3 files in one request. The
// frontend (WeightConfirmationPanel) also downscales/re-encodes photos
// client-side before upload so real phone photos (often 3-8MB) fit comfortably.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1.4 * 1024 * 1024, files: 3 } });

function runMulter(req: any, res: any): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.array('photos', 3)(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Weight-confirmation photos (AIR shipments, max 3) — uploads to Google Drive
 * under <root>/<batch_id>/<shipment_id>/ and stores the resulting folder link
 * in vendor_shipments.drive_link (Supabase-only, never synced to Apps Script).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    await runMulter(req, res);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to parse upload.' });
  }

  const shipmentId = ((req.body?.shipment_id as string) || '').trim();
  const batchId = ((req.body?.batch_id as string) || '').trim();
  if (!shipmentId) return res.status(400).json({ error: 'shipment_id is required.' });
  if (!batchId) return res.status(400).json({ error: 'batch_id is required.' });

  const files = ((req as any).files as Express.Multer.File[]) || [];
  if (!files.length) return res.status(400).json({ error: 'At least one photo is required.' });

  try {
    const driveLink = await googleDriveService.uploadShipmentPhotos(
      batchId,
      shipmentId,
      files.map(f => ({ originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer }))
    );
    await vendorShipmentRepo.updateShipmentDriveLink(shipmentId, driveLink);
    return res.json({ success: true, drive_link: driveLink });
  } catch (err: any) {
    console.error('[API] shipment-upload-weight-photos error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to upload photos to Drive.' });
  }
}
