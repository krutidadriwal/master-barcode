import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createServer as createViteServer } from 'vite';
import { SupabaseProductRepository } from './api/_lib/SupabaseProductRepository';
import { SupabaseShipmentRepository } from './api/_lib/SupabaseShipmentRepository';
import { ProductionOrderRepository } from './api/_lib/ProductionOrderRepository';
import { ProductionOrderGSheetSyncService } from './api/_lib/ProductionOrderGSheetSyncService';
import { EasyEcomProductMasterSyncService } from './api/_lib/EasyEcomProductMasterSyncService';
import { SupabasePurchaseOrderRepository } from './api/_lib/SupabasePurchaseOrderRepository';

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
  const PORT = 3000;

  // Body parser — 10mb limit for base64 PDF payloads from the silent print endpoint
  app.use(express.json({ limit: '10mb' }));

  // Initialize repositories
  const repository = new SupabaseProductRepository();
  const shipmentRepository = new SupabaseShipmentRepository();
  const poRepository = new SupabasePurchaseOrderRepository();
  const productionOrderRepository = new ProductionOrderRepository();
  const productionOrderSyncService = new ProductionOrderGSheetSyncService();

  // BFF API Routes
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
   * Fetch all custom shipment list entries from shipment_barcode table.
   */
  app.get('/api/shipment/list', async (req, res) => {
    try {
      const raw = (req.query.mode as string || 'AIR').toUpperCase();
      const mode = (raw === 'SEA' ? 'SEA' : 'AIR') as 'AIR' | 'SEA';
      const items = await shipmentRepository.getAllShipments(mode);
      return res.json(items);
    } catch (error: any) {
      console.error('[BFF API] Get shipment list error:', error);
      return res.status(500).json({ error: 'Failed to retrieve shipment inventory.' });
    }
  });

  /**
   * Sync and aggregate shipments from Google Sheet or load high fidelity demo data.
   */
  app.post('/api/shipment/sync', async (req, res) => {
    try {
      const { demo } = req.body || {};
      let rawData: any[] = [];

      if (!demo) {
        const scriptUrl = process.env.APP_SCRIPTS_URL;
        if (!scriptUrl || !scriptUrl.trim()) {
          throw new Error('APP_SCRIPTS_URL is not set in environment variables.');
        }
        console.log(`[BFF Shipment Sync] Fetching from Apps Script: ${scriptUrl}`);
        const response = await fetch(scriptUrl);
        if (!response.ok) {
          throw new Error(`Google Apps Script responded with status: ${response.status}`);
        }
        rawData = await response.json();
        if (!Array.isArray(rawData)) {
          throw new Error("Apps Script response is not a JSON array.");
        }
      } else {
        // High fidelity demo fallback: Match existing system products, or generate defaults with non-zero fulfilled quantities
        const allProducts = await repository.getAllProducts();
        if (allProducts && allProducts.length > 0) {
          rawData = allProducts.slice(0, 4).map((p, index) => {
            const ordered = (index + 2) * 15; // 30, 45, 60, 75
            const fulfilled = (index + 1) * 6; // 6, 12, 18, 24 (all less than ordered)
            return {
              sku: p.sku,
              sku_name: p.product_name,
              ordered_qty: ordered,
              fulfilled_qty: fulfilled
            };
          });
        } else {
          // Absolute fallback if product database is completely empty
          rawData = [
            {
              sku: "1020137",
              sku_name: "QiYi MP 2x2 M Stickerless",
              ordered_qty: 50,
              fulfilled_qty: 15
            },
            {
              sku: "1020080",
              sku_name: "QiYi QiDi S 2x2 Stickerless",
              ordered_qty: 25,
              fulfilled_qty: 5
            },
            {
              sku: "1030405",
              sku_name: "MoYu MeiLong 3C 3x3 Stickerless",
              ordered_qty: 100,
              fulfilled_qty: 20
            }
          ];
        }
      }

      // Group and aggregate by (sku, planned_mode)
      const aggregated: { [key: string]: { sku: string; planned_mode: 'AIR' | 'SEA'; sku_name: string; ordered_qty: number; fulfilled_qty: number; product_id?: string } } = {};

      for (const row of rawData) {
        const sku = (row.sku || '').toString().trim();
        if (!sku) continue;

        const rawMode = (row.planned_mode || 'AIR').toString().trim().toUpperCase();
        const planned_mode: 'AIR' | 'SEA' = rawMode === 'SEA' ? 'SEA' : 'AIR';
        const key = `${sku}|${planned_mode}`;

        const ordered = parseInt(row.ordered_qty, 10) || 0;
        const fulfilled = parseInt(row.fulfilled_qty, 10) || 0;
        const name = (row.sku_name || row.item_name || 'Unnamed Product').toString().trim();

        if (aggregated[key]) {
          aggregated[key].ordered_qty += ordered;
          aggregated[key].fulfilled_qty += fulfilled;
          if (!aggregated[key].sku_name || aggregated[key].sku_name === 'Unnamed Product') {
            aggregated[key].sku_name = name;
          }
        } else {
          aggregated[key] = { sku, planned_mode, sku_name: name, ordered_qty: ordered, fulfilled_qty: fulfilled };
        }
      }

      // Try matching standard product_id from the database
      const products = await repository.getAllProducts();
      for (const key in aggregated) {
        const { sku } = aggregated[key];
        const matchingProduct = products.find(p => p.sku && p.sku.toLowerCase() === sku.toLowerCase());
        if (matchingProduct) {
          aggregated[key].product_id = matchingProduct.product_id;
        }
      }

      const itemsToUpsert = Object.values(aggregated).map(item => ({
        sku: item.sku,
        planned_mode: item.planned_mode,
        product_id: item.product_id,
        sku_name: item.sku_name,
        cu_ordered_qty: item.ordered_qty,
        fulfilled_qty: 0  // fulfilled_qty is managed by Supabase only via Confirm Session
      }));

      const upserted = await shipmentRepository.upsertShipmentItems(itemsToUpsert);
      return res.json({ success: true, count: upserted.length, data: upserted });
    } catch (error: any) {
      console.error('[BFF Shipment Sync] Sync error:', error);
      return res.status(500).json({ error: error.message || 'Failed to sync Google Sheet shipment data.' });
    }
  });

  /**
   * Confirm current scan session. Increment database fulfilled quantities by scanned counted quantities.
   */
  /**
   * Real-time scan write: increments session_qty by 1 for the scanned SKU immediately on each scan.
   */
  app.post('/api/shipment/scan', async (req, res) => {
    try {
      const { sku, sku_name, product_id, planned_mode } = req.body;
      if (!sku) return res.status(400).json({ error: 'sku is required.' });
      const mode: 'AIR' | 'SEA' = (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';
      await shipmentRepository.incrementSessionQty(sku, sku_name || sku, product_id || null, mode);
      return res.json({ success: true });
    } catch (error: any) {
      console.error('[BFF API] Real-time scan write error:', error);
      return res.status(500).json({ error: error.message || 'Failed to persist scan.' });
    }
  });

  /**
   * Confirm session: moves session_qty → fulfilled_qty and resets session_qty = 0.
   */
  app.post('/api/shipment/confirm', async (req, res) => {
    try {
      const { planned_mode } = req.body;
      const mode: 'AIR' | 'SEA' = (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';
      await shipmentRepository.commitSession(mode);
      return res.json({ success: true });
    } catch (error: any) {
      console.error('[BFF API] Session confirmation error:', error);
      return res.status(500).json({ error: error.message || 'Failed to confirm session.' });
    }
  });

  /**
   * Discard session: resets session_qty = 0 without touching fulfilled_qty.
   */
  app.post('/api/shipment/discard', async (req, res) => {
    try {
      const { planned_mode } = req.body;
      const mode: 'AIR' | 'SEA' = (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';
      await shipmentRepository.discardSession(mode);
      return res.json({ success: true });
    } catch (error: any) {
      console.error('[BFF API] Discard session error:', error);
      return res.status(500).json({ error: error.message || 'Failed to discard session.' });
    }
  });

  /**
   * Reset the database shipment table completely
   */
  app.post('/api/shipment/reset', async (req, res) => {
    try {
      const { planned_mode } = req.body || {};
      const mode: 'AIR' | 'SEA' = (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';
      await shipmentRepository.resetShipments(mode);
      return res.json({ success: true, message: `${mode} shipment barcodes wiped successfully.` });
    } catch (error: any) {
      console.error('[BFF API] Reset shipment error:', error);
      return res.status(500).json({ error: 'Failed to reset shipments table.' });
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
  if (process.env.CENTRAL_DB_URL) {
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
