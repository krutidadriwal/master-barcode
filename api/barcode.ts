import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SupabaseProductRepository } from './_lib/SupabaseProductRepository.js';
import nodemailer from 'nodemailer';

const repository = new SupabaseProductRepository();

interface DuplicateEANEntry {
  ean: string;
  affectedProducts: Array<{ sku: string; productName: string }>;
  timestamp: string;
  module: string;
}

async function sendDuplicateEANEmail(duplicates: DuplicateEANEntry[], moduleName: string): Promise<void> {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.warn('[Email] SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing) — skipping duplicate EAN email.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: smtpUser, pass: smtpPass },
  });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const bodyText = duplicates.map(entry => {
    const skuLines = entry.affectedProducts
      .map(p => `  SKU: ${p.sku}\n  Product: ${p.productName}`)
      .join('\n\n');
    return `EANUPC: ${entry.ean}\n\nAffected Products:\n\n${skuLines}`;
  }).join('\n\n---\n\n');

  await transporter.sendMail({
    from: smtpUser,
    to: 'kruti@cubelelo.com',
    subject: '[Barcode Tool] Duplicate EANUPC Detected - Printing Blocked',
    text: `Duplicate EANUPC detected in Barcode Tool.\n\nModule: ${moduleName}\nTimestamp: ${timestamp}\n\n${bodyText}\n\nPrinting was blocked automatically.`,
  });

  console.log(`[Email] Duplicate EAN escalation sent for ${duplicates.length} EAN(s) from module: ${moduleName}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;

  try {
    // POST /api/barcode/search
    if (action === 'search') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { identifier } = req.body;
      if (!identifier) return res.status(400).json({ error: 'Identifier parameter is required.' });
      const product = await repository.searchProduct(identifier);
      if (!product) return res.status(404).json({ error: 'Product not found.' });
      return res.json(product);
    }

    // GET /api/barcode/products
    if (action === 'products') {
      const products = await repository.getAllProducts();
      return res.json(products);
    }

    // POST /api/barcode/add
    if (action === 'add') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { sku, item_name, mrp, ean_upc, batch_no } = req.body;
      if (!sku || !item_name || !mrp || !ean_upc) {
        return res.status(400).json({ error: 'sku, item_name, mrp, and ean_upc are all required.' });
      }
      const product = await repository.addProduct({ sku, item_name, mrp, ean_upc, batch_no });
      return res.status(201).json(product);
    }

    // POST /api/barcode/check-ean-duplicates
    if (action === 'check-ean-duplicates') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { ean } = req.body;
      if (!ean) return res.status(400).json({ error: 'ean is required.' });
      const products = await repository.findProductsByEANUPC(String(ean));
      return res.json({ isDuplicate: products.length > 1, products });
    }

    // POST /api/barcode/send-duplicate-ean-email
    if (action === 'send-duplicate-ean-email') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const { duplicates, module: moduleName } = req.body;
      if (!Array.isArray(duplicates)) return res.status(400).json({ error: 'duplicates array is required.' });
      await sendDuplicateEANEmail(duplicates, moduleName || 'Barcode Tool');
      return res.json({ sent: true });
    }

    // POST /api/barcode/sync-barcode-master
    if (action === 'sync-barcode-master') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
      const scriptUrl = process.env.MASTER_BARCODE_SCRIPTS_URL;
      if (!scriptUrl) return res.status(503).json({ error: 'MASTER_BARCODE_SCRIPTS_URL is not configured.' });

      const url = new URL(scriptUrl);
      url.searchParams.set('action', 'barcodeProductMaster');
      const r = await fetch(url.toString());
      if (!r.ok) throw new Error(`App Script responded ${r.status}`);
      const raw = await r.json() as any;

      const rows: any[] =
        Array.isArray(raw)          ? raw :
        Array.isArray(raw.data)     ? raw.data :
        Array.isArray(raw.records)  ? raw.records :
        Array.isArray(raw.products) ? raw.products :
        [];

      if (!rows.length) {
        return res.status(200).json({ message: 'App Script returned 0 rows.', upserted: 0, errors: 0 });
      }

      const result = await repository.syncBarcodeProductMaster(rows);
      return res.json({ ...result, total: rows.length });
    }

    return res.status(404).json({ error: `Unknown barcode action: ${action}` });
  } catch (error: any) {
    console.error(`[API] barcode/${action} error:`, error);
    return res.status(500).json({ error: error.message || 'Internal server error.' });
  }
}
