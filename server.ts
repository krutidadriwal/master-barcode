import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import nodemailer from 'nodemailer';
import { createServer as createViteServer } from 'vite';
import { SupabaseProductRepository } from './api/_lib/SupabaseProductRepository';
import { SupabaseShipmentRepository } from './api/_lib/SupabaseShipmentRepository';
import { SupabaseVendorShipmentRepository } from './api/_lib/SupabaseVendorShipmentRepository';
import { ProductionOrderRepository } from './api/_lib/ProductionOrderRepository';
import { ProductionOrderGSheetSyncService } from './api/_lib/ProductionOrderGSheetSyncService';
import { EasyEcomProductMasterSyncService } from './api/_lib/EasyEcomProductMasterSyncService';
import { SupabasePurchaseOrderRepository } from './api/_lib/SupabasePurchaseOrderRepository';
import { SupabaseReceivingSheetRepository } from './api/_lib/SupabaseReceivingSheetRepository';
import { GoogleDriveService, getGoogleDriveAuthUrl, exchangeGoogleDriveAuthCode } from './api/_lib/GoogleDriveService';

async function startServer() {
  // Lazy-load pdf-to-printer inside the async function to avoid top-level-await issues with tsx
  let silentPrint: ((filePath: string) => Promise<void>) | null = null;
  try {
    const m = await import('pdf-to-printer');
    silentPrint = m.print;
    console.log('[BFF Server] pdf-to-printer loaded — silent print endpoint active.');
  } catch {
    console.warn('[BFF Server] pdf-to-printer not available — /api/print/silent will return 503.');
  }
  const app = express();
  const PORT = 5000;

  // Body parser — 10mb limit for base64 PDF payloads from the silent print endpoint
  app.use(express.json({ limit: '10mb' }));

  // Initialize repositories
  const repository = new SupabaseProductRepository();
  void new SupabaseShipmentRepository(); // kept for legacy table compatibility
  const vendorShipmentRepo = new SupabaseVendorShipmentRepository();
  const poRepository = new SupabasePurchaseOrderRepository();
  const receivingSheetRepo = new SupabaseReceivingSheetRepository();
  const googleDriveService = new GoogleDriveService();
  // Vercel serverless functions hard-cap the total request body at ~4.5MB (a
  // platform limit, not something multer/Express enforce) — kept in sync with
  // api/shipment-upload-weight-photos.ts even though this local Express server
  // isn't subject to it, so behavior matches between dev and prod. The frontend
  // uploads photos in batches of 3 (see UPLOAD_BATCH_SIZE in
  // WeightConfirmationPanel.tsx) and downscales/re-encodes each one client-side,
  // so `files: 3` here is a per-request (per-batch) cap, not the overall photo
  // limit — up to 15 photos total arrive as up to 5 sequential requests.
  const weightPhotoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1.4 * 1024 * 1024, files: 3 } });
  const productionOrderRepository = new ProductionOrderRepository();
  const productionOrderSyncService = new ProductionOrderGSheetSyncService();

  // BFF API Routes
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  /**
   * One-time Google Drive OAuth setup for the weight-confirmation photo uploads.
   * Visit /api/drive/oauth/start, complete the Google consent screen, then copy
   * the refresh token it displays into GOOGLE_DRIVE_REFRESH_TOKEN.
   */
  app.get('/api/drive/oauth/start', (_req, res) => {
    try {
      res.redirect(getGoogleDriveAuthUrl());
    } catch (err: any) {
      res.status(500).send(err.message);
    }
  });

  app.get('/api/drive/oauth/callback', async (req, res) => {
    const code = (req.query.code as string) || '';
    if (!code) return res.status(400).send('Missing ?code from Google.');
    try {
      const tokens = await exchangeGoogleDriveAuthCode(code);
      console.log('[Google Drive OAuth] Refresh token:', tokens.refresh_token);
      res.send(`
        <html><body style="font-family: sans-serif; padding: 2rem; max-width: 640px; margin: 0 auto;">
          <h2>Google Drive connected</h2>
          <p>Copy this into your <code>.env</code> as <code>GOOGLE_DRIVE_REFRESH_TOKEN</code>, then restart the server:</p>
          <pre style="background:#eee;padding:1rem;border-radius:8px;word-break:break-all;user-select:all;">${tokens.refresh_token || '(No refresh token returned — you likely already granted consent before. Revoke access at https://myaccount.google.com/permissions for this app, then try again.)'}</pre>
        </body></html>
      `);
    } catch (err: any) {
      res.status(500).send(`OAuth exchange failed: ${err.message}`);
    }
  });

  /**
   * Silent print endpoint — receives a base64-encoded PDF and sends it directly
   * to the OS default printer via pdf-to-printer (bypasses browser print dialog).
   * Only functional on the local Express server; not deployed to Vercel.
   */
  app.post('/api/print/silent', async (req, res) => {
    if (!silentPrint) {
      return res.status(503).json({ error: 'pdf-to-printer not available on this server.' });
    }
    const { pdf_base64 } = req.body;
    if (!pdf_base64) {
      return res.status(400).json({ error: 'pdf_base64 is required.' });
    }
    const tmpPath = path.join(os.tmpdir(), `label_${Date.now()}.pdf`);
    try {
      fs.writeFileSync(tmpPath, Buffer.from(pdf_base64, 'base64'));
      await silentPrint(tmpPath);
      console.log(`[BFF Silent Print] Sent label PDF to default printer.`);
      return res.json({ success: true });
    } catch (err: any) {
      console.error('[BFF Silent Print] Failed:', err);
      return res.status(500).json({ error: err.message || 'Silent print failed.' });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  });

  /**
   * Search endpoint
   * Request format: { "identifier": "123456" }
   * Response format: { "product_id": "", "sku": "", "item_name": "", "mrp": "", "ean_upc": "" }
   */
  app.post('/api/barcode/search', async (req, res) => {
    try {
      const { identifier } = req.body;

      if (!identifier) {
        return res.status(400).json({ error: 'Identifier parameter is required.' });
      }

      const product = await repository.searchProduct(identifier);
      
      if (!product) {
        return res.status(404).json({ error: 'Product not found.' });
      }

      return res.json(product);
    } catch (error: any) {
      console.error('[BFF API] Search error:', error);
      return res.status(500).json({ error: 'Internal failure searching database repository.' });
    }
  });

  /**
   * Check if a given EANUPC is duplicated across multiple SKUs.
   */
  app.post('/api/barcode/check-ean-duplicates', async (req, res) => {
    try {
      const { ean, sku } = req.body;
      if (!ean && !sku) return res.status(400).json({ error: 'ean or sku is required.' });
      const products = await repository.findDuplicates(String(sku || ''), String(ean || ''));
      const isDuplicate = products.length > 1;
      console.log(`[BFF API] check-ean-duplicates(sku="${sku}", ean="${ean}"): ${products.length} product(s) found, isDuplicate=${isDuplicate}. SKUs: [${products.map(p => p.sku).join(', ')}]`);
      return res.json({ isDuplicate, products });
    } catch (error: any) {
      console.error('[BFF API] check-ean-duplicates error:', error);
      return res.status(500).json({ error: 'Duplicate EAN check failed.' });
    }
  });

  /**
   * GET  /api/barcode/settings  — return current app settings
   * PUT  /api/barcode/settings  — persist new settings
   */
  app.get('/api/barcode/settings', async (_req, res) => {
    try {
      const settings = await repository.getSettings();
      return res.json(settings);
    } catch (err: any) {
      console.error('[BFF API] GET settings error:', err);
      return res.status(500).json({ error: 'Failed to load settings.' });
    }
  });

  app.put('/api/barcode/settings', async (req, res) => {
    try {
      const { eanDuplicateEmails } = req.body;
      if (!Array.isArray(eanDuplicateEmails)) {
        return res.status(400).json({ error: 'eanDuplicateEmails must be an array.' });
      }
      await repository.saveSettings({ eanDuplicateEmails });
      return res.json({ saved: true });
    } catch (err: any) {
      console.error('[BFF API] PUT settings error:', err);
      return res.status(500).json({ error: 'Failed to save settings.' });
    }
  });

  /**
   * Send escalation email for accumulated duplicate EAN entries from a session.
   */
  app.post('/api/barcode/send-duplicate-ean-email', async (req, res) => {
    try {
      const { duplicates, module: moduleName } = req.body;
      if (!Array.isArray(duplicates)) return res.status(400).json({ error: 'duplicates array is required.' });

      const smtpHost = process.env.SMTP_HOST;
      const smtpUser = process.env.SMTP_USER;
      const smtpPass = process.env.SMTP_PASS;

      if (!smtpHost || !smtpUser || !smtpPass) {
        console.warn('[BFF Email] SMTP not configured — skipping duplicate EAN email.');
        return res.json({ sent: false, reason: 'SMTP not configured.' });
      }

      const { eanDuplicateEmails } = await repository.getSettings();
      const toAddresses = eanDuplicateEmails.length > 0 ? eanDuplicateEmails.join(', ') : smtpUser;

      if (!toAddresses) {
        console.warn('[BFF Email] No recipients configured — skipping duplicate EAN email.');
        return res.json({ sent: false, reason: 'No recipients configured.' });
      }

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: smtpUser, pass: smtpPass },
      });

      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      const bodyText = (duplicates as any[]).map((entry: any) => {
        const skuLines = (entry.affectedProducts || [])
          .map((p: any) => `  SKU: ${p.sku}\n  Product: ${p.productName}`)
          .join('\n\n');
        return `EANUPC: ${entry.ean}\n\nAffected Products:\n\n${skuLines}`;
      }).join('\n\n---\n\n');

      await transporter.sendMail({
        from: smtpUser,
        to: toAddresses,
        subject: '[Barcode Tool] Duplicate EANUPC Detected - Printing Blocked',
        text: `Duplicate EANUPC detected in Barcode Tool.\n\nModule: ${moduleName || 'Barcode Tool'}\nTimestamp: ${timestamp}\n\n${bodyText}\n\nPrinting was blocked automatically.`,
      });

      console.log(`[BFF Email] Duplicate EAN escalation sent to "${toAddresses}" for ${duplicates.length} EAN(s).`);
      return res.json({ sent: true });
    } catch (error: any) {
      console.error('[BFF API] send-duplicate-ean-email error:', error);
      return res.status(500).json({ error: error.message || 'Failed to send email.' });
    }
  });

  /**
   * Get all products (helpful for user cheat-sheet/dropdown inside sandbox)
   */
  app.get('/api/barcode/products', async (_req, res) => {
    try {
      const products = await repository.getAllProducts();
      return res.json(products);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to retrieve products list.' });
    }
  });

  /**
   * Sync product master from central EasyEcomProductMaster database.
   * Requires CENTRAL_DB_URL and DATABASE_URL to be configured.
   */
  app.post('/api/product-master/sync', async (_req, res) => {
    try {
      const syncService = new EasyEcomProductMasterSyncService();
      const result = await syncService.sync();
      await syncService.close();
      return res.json({ success: true, ...result });
    } catch (err: any) {
      console.error('[BFF Product Master Sync] Failed:', err);
      return res.status(500).json({ error: err.message || 'Product master sync failed.' });
    }
  });

  /**
   * Sync product master from App Script (MASTER_BARCODE_SCRIPTS_URL) into
   * the local barcode_product_master Supabase table.
   * Only meaningful when APP_SCRIPT_FOR_BARCODE=true.
   */
  app.post('/api/barcode/sync-barcode-master', async (_req, res) => {
    const scriptUrl = process.env.MASTER_BARCODE_SCRIPTS_URL;
    if (!scriptUrl) {
      return res.status(503).json({ error: 'MASTER_BARCODE_SCRIPTS_URL is not configured.' });
    }
    try {
      const url = new URL(scriptUrl);
      url.searchParams.set('action', 'barcodeProductMaster');
      const r = await fetch(url.toString());
      if (!r.ok) throw new Error(`App Script responded ${r.status}`);
      const raw = await r.json() as any;

      // Accept several common response shapes from the App Script
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
      console.log(`[BFF Barcode Sync] Sync complete: ${result.upserted} upserted, ${result.errors} errors.`);
      return res.json({ ...result, total: rows.length });
    } catch (err: any) {
      console.error('[BFF Barcode Sync] Failed:', err);
      return res.status(500).json({ error: err.message || 'Barcode product master sync failed.' });
    }
  });

  /**
   * Fetch all custom shipment list entries from shipment_barcode table.
   */
  /**
   * Sync shipment data from Google Sheet → Supabase.
   * Calls Apps Script action 'sync_shipment_data' which reads Batches,
   * Vendor_Shipments, and Vendor_Shipment_Lines tabs and returns all rows.
   * scanned_quantity on existing lines is preserved (not overwritten by sync).
   */
  // Writes Supabase scanned_quantity back to the Google Sheet via Apps Script.
  async function runShipmentWriteback() {
    const scriptUrl = process.env.APP_SCRIPTS_URL;
    if (!scriptUrl?.trim()) return;
    const updates = await vendorShipmentRepo.getScannedQuantitiesForWriteback();
    if (!updates.length) return;
    console.log(`[Shipment Writeback] Pushing ${updates.length} line(s) to sheet…`);
    const r = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_scanned_quantities', updates }),
    });
    if (!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
    const data = await r.json();
    if (!data.success) throw new Error(data.error || 'Apps Script writeback failed');
    console.log(`[Shipment Writeback] Done — updated ${data.updated} row(s) in sheet.`);
  }

  // Hourly writeback to sheet.
  setInterval(() => {
    runShipmentWriteback().catch(err =>
      console.error('[Shipment Writeback] Hourly job error:', err.message)
    );
  }, 60 * 60 * 1000);

  // Debug: returns raw Apps Script response without storing to Supabase
  app.get('/api/shipment/sync-debug', async (_req, res) => {
    const scriptUrl = process.env.APP_SCRIPTS_URL;
    if (!scriptUrl?.trim()) return res.status(503).json({ error: 'APP_SCRIPTS_URL not configured.' });
    try {
      const r = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_shipment_data' }),
      });
      const data = await r.json();
      const firstBatch    = (data.batches    || [])[0] || null;
      const firstShipment = (data.shipments  || [])[0] || null;
      const firstLine     = (data.lines      || [])[0] || null;
      return res.json({
        counts: { batches: data.batches?.length, shipments: data.shipments?.length, lines: data.lines?.length },
        sample_batch:    firstBatch,
        sample_shipment: firstShipment,
        sample_line:     firstLine,
        batch_keys:    firstBatch    ? Object.keys(firstBatch)    : [],
        shipment_keys: firstShipment ? Object.keys(firstShipment) : [],
        line_keys:     firstLine     ? Object.keys(firstLine)     : [],
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shipment/sync', async (_req, res) => {
    const scriptUrl = process.env.APP_SCRIPTS_URL;
    if (!scriptUrl?.trim()) {
      return res.status(503).json({ error: 'APP_SCRIPTS_URL is not configured.' });
    }
    try {
      console.log('[Shipment Sync] Calling Apps Script sync_shipment_data…');
      // Kicked off now, awaited at the end — it hits a completely separate Apps
      // Script deployment (INVENTORY_SCRIPTS_URL) and Supabase table, so there's
      // no reason to pay for its ~5s round trip sequentially after this one.
      const receivingSheetPromise: Promise<{ lines: number } | { error: string }> =
        syncReceivingSheet().catch(err => {
          console.warn('[Receiving Sheet Sync] Skipped/failed:', err.message);
          return { error: err.message };
        });
      const r = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_shipment_data' }),
      });
      if (!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
      const raw = await r.text();
      console.log('[Shipment Sync] Raw Apps Script response:', raw.slice(0, 500));
      let data: any;
      try { data = JSON.parse(raw); } catch { throw new Error(`Apps Script response is not valid JSON: ${raw.slice(0, 200)}`); }
      if (!data.success) throw new Error(data.error || data.message || `Apps Script returned: ${JSON.stringify(data).slice(0, 200)}`);

      const rawBatches:   any[] = data.batches   || [];
      const rawShipments: any[] = data.shipments  || [];
      const rawLines:     any[] = data.lines      || [];

      // Map Batches (sheet headers are snake_case)
      const batches = rawBatches
        .filter((b: any) => b['batch_id'])
        .map((b: any) => ({
          batch_id:          String(b['batch_id']          || '').trim(),
          status:            String(b['status']            || '').trim() || null,
          expected_delivery: String(b['expected_delivery'] || '').trim() || null,
          actual_delivery:   String(b['actual_delivery']   || '').trim() || null,
          carrier:           String(b['carrier']           || '').trim() || null,
          remarks:           String(b['remarks']           || '').trim() || null,
        }));

      // Map Vendor_Shipments (no total_units column — computed from lines below)
      const shipments = rawShipments
        .filter((s: any) => s['shipment_id'])
        .map((s: any) => ({
          shipment_id:  String(s['shipment_id']  || '').trim(),
          batch_id:     String(s['batch_id']     || '').trim(),
          vendor_code:  String(s['vendor_code']  || '').trim() || null,
          invoice_no:   String(s['invoice_no']   || '').trim() || null,
          invoice_date: String(s['invoice_date'] || '').trim() || null,
          carton_count: parseInt(s['carton_count'] || 0, 10) || 0,
          total_units:  0, // computed below from lines
        }));

      // Map Vendor_Shipment_Lines (qty column is invoice_qty; line_id comes from sheet)
      const lines = rawLines
        .filter((l: any) => l['shipment_id'] && l['sku'])
        .map((l: any) => {
          const shipmentId = String(l['shipment_id'] || '').trim();
          const sku        = String(l['sku']         || '').trim();
          return {
            line_id:          `${shipmentId}::${sku}`,
            shipment_id:      shipmentId,
            batch_id:         String(l['batch_id']    || '').trim(),
            vendor_code:      String(l['vendor_code'] || '').trim() || null,
            sku,
            item_name:        String(l['item_name']   || sku).trim(),
            ean:              String(l['ean']         || '').trim() || null,
            incoming_qty:     parseInt(l['invoice_qty'] ?? l['qty'] ?? l['invoice_quantity'] ?? 0, 10) || 0,
            scanned_quantity: 0, // never read from sheet — preserved in DB by syncLines
          };
        });

      // Compute total_units per shipment from mapped lines
      const unitsByShipment: Record<string, number> = {};
      for (const l of lines) unitsByShipment[l.shipment_id] = (unitsByShipment[l.shipment_id] || 0) + l.incoming_qty;
      for (const s of shipments) s.total_units = unitsByShipment[s.shipment_id] || 0;

      // Must be sequential: lines FK → shipments FK → batches
      const bCount = await vendorShipmentRepo.syncBatches(batches);
      const sCount = await vendorShipmentRepo.syncShipments(shipments);
      const lCount = await vendorShipmentRepo.syncLines(lines);

      console.log(`[Shipment Sync] Done — batches:${bCount} shipments:${sCount} lines:${lCount}`);

      // Best-effort: a failure here (e.g. flag off, script URL unset) must not fail the
      // shipment sync that the Refresh button is primarily used for.
      const receivingSheetResult = await receivingSheetPromise;
      if ('lines' in receivingSheetResult) {
        console.log(`[Receiving Sheet Sync] Done — lines:${receivingSheetResult.lines}`);
      }

      return res.json({ success: true, batches: bCount, shipments: sCount, lines: lCount, receiving_sheet: receivingSheetResult });
    } catch (err: any) {
      console.error('[Shipment Sync] Failed:', err.message);
      return res.status(500).json({ error: err.message || 'Shipment sync failed.' });
    }
  });

  /**
   * Returns batch list from Supabase with computed summary fields.
   */
  app.get('/api/shipment/batches', async (_req, res) => {
    try {
      const batches   = await vendorShipmentRepo.getBatches();
      const shipments = await Promise.all(
        batches.map(b => vendorShipmentRepo.getShipmentsForBatch(b.batch_id))
      );

      const result = batches.map((b, i) => {
        const batchShipments = shipments[i];
        const batchId        = b.batch_id;
        const batchType      = batchId.toUpperCase().startsWith('A') ? 'air' : 'sea';
        const totalUnits     = batchShipments.reduce((sum, s) => sum + (s.total_units || 0), 0);
        const totalCartons   = batchShipments.reduce((sum, s) => sum + (s.carton_count || 0), 0);

        return {
          batch_id:          batchId,
          batch_type:        batchType,
          status:            b.status || 'unknown',
          total_shipments:   batchShipments.length,
          total_cartons:     totalCartons,
          total_units:       totalUnits,
          expected_delivery: b.expected_delivery || null,
          actual_delivery:   b.actual_delivery   || null,
          carrier:           b.carrier || null,
          is_delayed:        false,
          delay_days:        0,
          vendor_summary:    batchShipments.map(s => ({
            vendor_code:  s.vendor_code,
            shipment_id:  s.shipment_id,
            carton_count: s.carton_count,
            invoice_no:   s.invoice_no,
            invoice_date: s.invoice_date,
            total_units:  s.total_units,
          })),
        };
      });

      return res.json(result);
    } catch (err: any) {
      console.error('[BFF] GET /api/shipment/batches error:', err.message);
      return res.status(500).json({ error: err.message || 'Failed to load batches.' });
    }
  });

  /**
   * Returns full batch detail (shipments + lines with scanned_quantity) from Supabase.
   */
  app.get('/api/shipment/batch-detail', async (req, res) => {
    const batchId = ((req.query.batch_id as string) || '').trim();
    if (!batchId) return res.status(400).json({ error: 'batch_id is required.' });
    try {
      const [shipments, lines] = await Promise.all([
        vendorShipmentRepo.getShipmentsForBatch(batchId),
        vendorShipmentRepo.getLinesForBatch(batchId),
      ]);

      const linesByShipment: Record<string, typeof lines> = {};
      for (const l of lines) {
        if (!linesByShipment[l.shipment_id]) linesByShipment[l.shipment_id] = [];
        linesByShipment[l.shipment_id].push(l);
      }

      const batchType = batchId.toUpperCase().startsWith('A') ? 'air' : 'sea';

      const batch = {
        batch_id:         batchId,
        batch_type:       batchType,
        status:           shipments.length ? 'open' : 'unknown',
        vendor_shipments: shipments.map(s => ({
          shipment_id:  s.shipment_id,
          vendor_code:  s.vendor_code,
          vendor_name:  s.vendor_code,
          invoice_no:   s.invoice_no,
          total_units:  s.total_units,
          carton_count: s.carton_count,
          listed_weight: s.listed_weight ?? null,
          actual_weight: s.actual_weight ?? null,
          line_items:   (linesByShipment[s.shipment_id] || []).map(l => ({
            line_id:          l.line_id,
            sku:              l.sku,
            item_name:        l.item_name,
            ean:              l.ean,
            incoming_qty:     l.incoming_qty,
            scanned_quantity: l.scanned_quantity,
          })),
        })),
      };

      return res.json({ batch });
    } catch (err: any) {
      console.error('[BFF] GET /api/shipment/batch-detail error:', err.message);
      return res.status(500).json({ error: err.message || 'Failed to load batch detail.' });
    }
  });

  /**
   * Records a single scan: increments scanned_quantity by 1 for the given line_id in Supabase.
   */
  app.post('/api/shipment/scan-line', async (req, res) => {
    const { line_id } = req.body;
    if (!line_id) return res.status(400).json({ error: 'line_id is required.' });
    try {
      await vendorShipmentRepo.incrementScannedQty(line_id);
      return res.json({ success: true });
    } catch (err: any) {
      console.error('[BFF] POST /api/shipment/scan-line error:', err.message);
      return res.status(500).json({ error: err.message || 'Failed to record scan.' });
    }
  });

  /**
   * Weight confirmation (AIR shipments) — cumulative listed/measured weight totals.
   * Supabase-only columns (listed_weight/actual_weight on vendor_shipments); never
   * sent to or read from Apps Script, so a later sheet re-sync can't touch/clear them.
   */
  app.post('/api/shipment/confirm-weights', async (req, res) => {
    const { shipment_id, listed_weight, actual_weight } = req.body || {};
    if (!shipment_id) return res.status(400).json({ error: 'shipment_id is required.' });
    const listedWeight = parseFloat(listed_weight);
    const actualWeight = parseFloat(actual_weight);
    if (!Number.isFinite(listedWeight) || !Number.isFinite(actualWeight)) {
      return res.status(400).json({ error: 'listed_weight and actual_weight must be numbers.' });
    }
    try {
      await vendorShipmentRepo.updateShipmentWeights(shipment_id, listedWeight, actualWeight);
      return res.json({ success: true });
    } catch (err: any) {
      console.error('[BFF] POST /api/shipment/confirm-weights error:', err.message);
      return res.status(500).json({ error: err.message || 'Failed to save weights.' });
    }
  });

  /**
   * Weight-confirmation photos (AIR shipments, max 3) — uploads to Google Drive
   * under <root>/<batch_id>/<shipment_id>/ and stores the resulting folder link
   * in vendor_shipments.drive_link (Supabase-only, never synced to Apps Script).
   */
  app.post('/api/shipment/upload-weight-photos', weightPhotoUpload.array('photos', 3), async (req, res) => {
    const shipmentId = (req.body?.shipment_id || '').trim();
    const batchId = (req.body?.batch_id || '').trim();
    if (!shipmentId) return res.status(400).json({ error: 'shipment_id is required.' });
    if (!batchId) return res.status(400).json({ error: 'batch_id is required.' });
    const files = (req.files as Express.Multer.File[]) || [];
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
      console.error('[BFF] POST /api/shipment/upload-weight-photos error:', err.message);
      return res.status(500).json({ error: err.message || 'Failed to upload photos to Drive.' });
    }
  });

  /**
   * Manual trigger: push all scanned_quantity values from Supabase back to the Google Sheet.
   * Also called automatically on the hourly interval started at server boot.
   */
  app.post('/api/shipment/writeback', async (_req, res) => {
    try {
      await runShipmentWriteback();
      return res.json({ success: true });
    } catch (err: any) {
      console.error('[Shipment Writeback] Failed:', err.message);
      return res.status(500).json({ error: err.message || 'Writeback failed.' });
    }
  });

  /**
   * Sync Purchase Orders from Google Sheet (PO_SCRIPTS_URL) into local Supabase tables.
   * Expects Apps Script to return { headers: [...], lines: [...] }.
   * Pass { demo: true } in body to load seeded demo data instead.
   */
  app.post('/api/shipment/po-sync', async (req, res) => {
    try {
      const { demo } = req.body || {};
      let headersRaw: any[] = [];
      let linesRaw: any[] = [];

      if (!demo) {
        const scriptUrl = process.env.PO_SCRIPTS_URL;
        if (!scriptUrl?.trim()) throw new Error('PO_SCRIPTS_URL is not set in environment.');
        console.log('[PO Sync] Fetching Apps Script URL:', scriptUrl.slice(0, 60) + '...');
        const response = await fetch(scriptUrl, { redirect: 'follow' });
        console.log('[PO Sync] Apps Script HTTP status:', response.status, response.statusText);
        const rawText = await response.text();
        console.log('[PO Sync] Apps Script raw response (first 500 chars):', rawText.slice(0, 500));
        if (!response.ok) throw new Error(`Apps Script responded with HTTP ${response.status}: ${rawText.slice(0, 200)}`);
        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch (parseErr) {
          throw new Error(`Apps Script response is not valid JSON. Got: ${rawText.slice(0, 200)}`);
        }
        if (data?.error) throw new Error(`Apps Script error: ${data.message || JSON.stringify(data)}`);
        headersRaw = Array.isArray(data.headers) ? data.headers : [];
        linesRaw   = Array.isArray(data.lines)   ? data.lines   : [];
        console.log(`[PO Sync] Parsed from Apps Script — headers: ${headersRaw.length}, lines: ${linesRaw.length}`);
      } else {
        headersRaw = [
          { po_id: 'PO-DEMO-001', po_ref_num: '24134-YJ',       vendor_name: 'Demo Vendor A', vendor_code: 'V001', po_status_id: '1', total_po_value: 15000, po_created_date: '2025-01-15', po_updated_date: '2025-01-20' },
          { po_id: 'PO-DEMO-002', po_ref_num: 'VS-PW260515-1',  vendor_name: 'Demo Vendor B', vendor_code: 'V002', po_status_id: '1', total_po_value: 8500,  po_created_date: '2025-02-01', po_updated_date: '2025-02-05' },
          { po_id: 'PO-DEMO-003', po_ref_num: '24119-PW',        vendor_name: 'Demo Vendor C', vendor_code: 'V003', po_status_id: '2', total_po_value: 22000, po_created_date: '2025-03-10', po_updated_date: '2025-03-12' },
        ];
        const allProducts = await repository.getAllProducts();
        const sample = allProducts.slice(0, 9);
        const refNums = ['24134-YJ', 'VS-PW260515-1', '24119-PW'];
        const poIds   = ['PO-DEMO-001', 'PO-DEMO-002', 'PO-DEMO-003'];
        linesRaw = sample.map((p, i) => ({
          po_ref_num: refNums[Math.floor(i / 3)],
          po_id:      poIds[Math.floor(i / 3)],
          sku: p.sku,
          original_quantity: (i % 3 + 2) * 10,
          pending_quantity:  (i % 3 + 2) * 10,
          item_price: 99.99,
        }));
      }

      const headers = headersRaw.map((h: any) => ({
        po_id:           String(h.po_id           || '').trim(),
        po_ref_num:      String(h.po_ref_num      || '').trim(),
        total_po_value:  h.total_po_value  != null ? parseFloat(h.total_po_value)  : undefined,
        po_status_id:    h.po_status_id    != null ? String(h.po_status_id).trim()  : undefined,
        po_created_date: h.po_created_date != null ? String(h.po_created_date).trim(): undefined,
        po_updated_date: h.po_updated_date != null ? String(h.po_updated_date).trim(): undefined,
        vendor_name:     h.vendor_name     != null ? String(h.vendor_name).trim()    : undefined,
        vendor_code:     h.vendor_code     != null ? String(h.vendor_code).trim()    : undefined,
      })).filter((h: any) => h.po_id && h.po_ref_num);

      const lines = linesRaw.map((l: any) => ({
        po_ref_num:        String(l.po_ref_num || '').trim(),
        po_id:             l.po_id != null ? String(l.po_id).trim() : undefined,
        sku:               String(l.sku || '').trim(),
        original_quantity: parseInt(l.original_quantity, 10) || 0,
        pending_quantity:  parseInt(l.pending_quantity  ?? l.original_quantity, 10) || 0,
        item_price:        l.item_price != null ? parseFloat(l.item_price) : undefined,
      })).filter((l: any) => l.po_ref_num && l.sku);

      console.log(`[PO Sync] After mapping+filter — headers: ${headers.length}, lines: ${lines.length}`);
      if (headers.length === 0) console.warn('[PO Sync] WARNING: 0 headers to upsert. Check po_id and po_ref_num columns in sheet.');
      if (lines.length === 0)   console.warn('[PO Sync] WARNING: 0 lines to upsert. Check sku and po_ref_num columns in sheet.');
      if (headers.length > 0)   console.log('[PO Sync] First header sample:', JSON.stringify(headers[0]));
      if (lines.length > 0)     console.log('[PO Sync] First line sample:',   JSON.stringify(lines[0]));

      const headerResult = await poRepository.upsertPOHeaders(headers);
      console.log('[PO Sync] Headers upsert result:', headerResult);
      const linesResult  = await poRepository.upsertPOLines(lines);
      console.log('[PO Sync] Lines upsert result:', linesResult);

      return res.json({
        success: true,
        headersInserted: headerResult.inserted,
        headersUpdated:  headerResult.updated,
        linesInserted:   linesResult.inserted,
        linesUpdated:    linesResult.updated,
      });
    } catch (err: any) {
      console.error('[PO Sync] FAILED:', err.message);
      console.error('[PO Sync] Full error:', err);
      return res.status(500).json({ error: err.message || 'Purchase order sync failed.' });
    }
  });

  /**
   * Return all PO lines for a given PO Ref Num.
   */
  app.get('/api/shipment/po-lines', async (req, res) => {
    try {
      const poRefNum = ((req.query.po_ref_num as string) || '').trim();
      if (!poRefNum) return res.status(400).json({ error: 'po_ref_num query parameter is required.' });
      const lines = await poRepository.getPOLinesByRefNum(poRefNum);
      return res.json(lines);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to fetch PO lines.' });
    }
  });

  /**
   * Return all distinct PO Ref Nums available locally (for the selector UI).
   */
  app.get('/api/shipment/po-ref-nums', async (_req, res) => {
    try {
      const refNums = await poRepository.getDistinctPORefNums();
      return res.json(refNums);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to fetch PO ref nums.' });
    }
  });

  /**
   * Download Receiving Sheet — sourced from the 'Inventory' Google Sheet's
   * "Purchase Orders" tab (a separate spreadsheet from the shipment/vendor sync).
   * Only wired up when APP_SCRIPT_FOR_BARCODE=true; the central DB flow for this
   * has not been built yet, so we return a clear error when the flag is off.
   */
  async function syncReceivingSheet(): Promise<{ lines: number }> {
    if (process.env.APP_SCRIPT_FOR_BARCODE !== 'true') {
      throw new Error('Central DB flow for the receiving sheet is not built yet. Set APP_SCRIPT_FOR_BARCODE=true to sync from the Inventory sheet.');
    }
    const scriptUrl = process.env.INVENTORY_SCRIPTS_URL;
    if (!scriptUrl?.trim()) throw new Error('INVENTORY_SCRIPTS_URL is not configured.');

    const r = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync_receiving_sheet_data' }),
    });
    if (!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
    const raw = await r.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { throw new Error(`Apps Script response is not valid JSON: ${raw.slice(0, 200)}`); }
    if (!data.success) throw new Error(data.error || data.message || `Apps Script returned: ${JSON.stringify(data).slice(0, 200)}`);

    const rawLines: any[] = data.lines || [];
    const lines = rawLines
      .filter((l: any) => l['po_id'] && l['item_sku'])
      .map((l: any) => {
        const poId    = String(l['po_id']    || '').trim();
        const itemSku = String(l['item_sku'] || '').trim();
        return {
          line_id:     `${poId}::${itemSku}`,
          po_id:       poId,
          po_ref_no:   String(l['po_ref_no']  || '').trim() || null,
          item_sku:    itemSku,
          ean_fnsku:   String(l['ean_fnsku']  || '').trim() || null,
          item_name:   String(l['item_name']  || itemSku).trim(),
          qty:         parseInt(l['qty'] ?? 0, 10) || 0,
          pending_qty: parseInt(l['pending_qty'] ?? 0, 10) || 0,
          shipment_id: String(l['shipment_id'] || '').trim() || null,
        };
      });

    const count = await receivingSheetRepo.syncLines(lines);
    return { lines: count };
  }

  app.post('/api/receiving-sheet/sync', async (_req, res) => {
    try {
      console.log('[Receiving Sheet Sync] Calling Apps Script sync_receiving_sheet_data…');
      const result = await syncReceivingSheet();
      console.log(`[Receiving Sheet Sync] Done — lines:${result.lines}`);
      return res.json({ success: true, lines: result.lines });
    } catch (err: any) {
      console.error('[Receiving Sheet Sync] Failed:', err.message);
      return res.status(501).json({ error: err.message || 'Receiving sheet sync failed.' });
    }
  });

  app.get('/api/receiving-sheet/lines', async (req, res) => {
    if (process.env.APP_SCRIPT_FOR_BARCODE !== 'true') {
      return res.status(501).json({ error: 'Central DB flow for the receiving sheet is not built yet. Set APP_SCRIPT_FOR_BARCODE=true to use the Inventory sheet flow.' });
    }
    try {
      const poId = ((req.query.po_id as string) || '').trim();
      const lines = poId
        ? await receivingSheetRepo.getLinesForPO(poId)
        : await receivingSheetRepo.getLines();
      return res.json({ success: true, lines });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to fetch receiving sheet lines.' });
    }
  });

  /**
   * Resolve any one of po_id / shipment_id / po_ref_no into the matching lines,
   * the other two identifiers, and the vendor shipment batch_id (looked up via
   * inventory_po_lines.po_ref_no = vendor_shipments.shipment_id).
   */
  app.get('/api/receiving-sheet/search', async (req, res) => {
    if (process.env.APP_SCRIPT_FOR_BARCODE !== 'true') {
      return res.status(501).json({ error: 'Central DB flow for the receiving sheet is not built yet. Set APP_SCRIPT_FOR_BARCODE=true to use the Inventory sheet flow.' });
    }
    try {
      const poId       = ((req.query.po_id as string)       || '').trim();
      const shipmentId = ((req.query.shipment_id as string) || '').trim();
      const poRefNo    = ((req.query.po_ref_no as string)   || '').trim();

      if (!poId && !shipmentId && !poRefNo) {
        return res.status(400).json({ error: 'One of po_id, shipment_id, or po_ref_no is required.' });
      }

      const lines = poId
        ? await receivingSheetRepo.getLinesByPoId(poId)
        : shipmentId
        ? await receivingSheetRepo.getLinesByShipmentId(shipmentId)
        : await receivingSheetRepo.getLinesByPoRefNo(poRefNo);

      if (!lines.length) {
        return res.json({ success: true, po_id: poId || null, po_ref_no: poRefNo || null, shipment_id: shipmentId || null, batch_id: null, lines: [] });
      }

      const resolvedPoRefNo = lines[0].po_ref_no;
      let batchId: string | null = null;
      if (resolvedPoRefNo) {
        const shipment = await vendorShipmentRepo.getShipmentByShipmentId(resolvedPoRefNo);
        batchId = shipment?.batch_id || null;
      }

      return res.json({
        success:     true,
        po_id:       lines[0].po_id,
        po_ref_no:   resolvedPoRefNo,
        shipment_id: lines[0].shipment_id,
        batch_id:    batchId,
        lines,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to search receiving sheet lines.' });
    }
  });

  app.get('/api/production-order/search', async (req, res) => {
    const code = (req.query.code || '').toString().trim();
    if (!code) return res.status(400).json({ error: 'code query parameter is required.' });
    try {
      const rows = await productionOrderRepository.searchByShortCode(code);
      return res.json(rows);
    } catch (error: any) {
      console.error('[BFF API] Production order search error:', error);
      return res.status(500).json({ error: error.message || 'Failed to search production orders.' });
    }
  });

  app.post('/api/production-order/update-match', async (req, res) => {
    const { id, user_sku, row_sku } = req.body;
    if (!id || user_sku === undefined || !row_sku) {
      return res.status(400).json({ error: 'id, user_sku, and row_sku are required.' });
    }
    const codeMatch = user_sku.toString().trim().toLowerCase() === row_sku.toString().trim().toLowerCase();
    try {
      await productionOrderRepository.updateCodeMatch(Number(id), codeMatch);
      return res.json({ code_match: codeMatch });
    } catch (error: any) {
      console.error('[BFF API] update-match error:', error);
      return res.status(500).json({ error: error.message || 'Failed to update code match.' });
    }
  });

  app.get('/api/production-order/list', async (_req, res) => {
    try {
      const rows = await productionOrderRepository.getAllOrders();
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
        status: row.cancelled_quantity > 0 ? 'Cancelled'
              : row.shipped_quantity >= row.item_quantity ? 'Completed'
              : 'Pending',
      }));
      return res.json(orders);
    } catch (error: any) {
      console.error('[BFF API] Production order list error:', error);
      return res.status(500).json({ error: error.message || 'Failed to retrieve production orders.' });
    }
  });

  app.post('/api/production-order/sync', async (_req, res) => {
    try {
      const result = await productionOrderSyncService.sync();
      return res.json({ success: true, ...result });
    } catch (error: any) {
      console.error('[BFF API] Production order sync error:', error);
      return res.status(500).json({ error: error.message || 'Failed to sync production orders from EasyEcom.' });
    }
  });

  // Vite development / production static server configuration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('[BFF Server] Vite development middleware mounted.');
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('[BFF Server] Serving production compiled assets from:', distPath);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[BFF Server] Core system listening on http://localhost:${PORT}`);
  });

  // Startup product master sync — fire-and-forget so server is never blocked
  // Skipped when APP_SCRIPT_FOR_BARCODE=true because the barcode table is the active source.
  if (process.env.CENTRAL_DB_URL && process.env.APP_SCRIPT_FOR_BARCODE !== 'true') {
    (async () => {
      try {
        console.log('[BFF Server] Running startup product master sync...');
        const syncService = new EasyEcomProductMasterSyncService();
        const result = await syncService.sync();
        await syncService.close();
        console.log(`[BFF Server] Startup sync complete — Inserted: ${result.inserted}, Updated: ${result.updated}, Deleted: ${result.deleted}, Total: ${result.total}`);
      } catch (err: any) {
        console.warn('[BFF Server] Startup product master sync failed (continuing with existing local data):', err.message);
      }
    })();
  }
}

startServer().catch((err) => {
  console.error('[BFF Server] Failed to bootstrap application server:', err);
});
