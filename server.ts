import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { SupabaseProductRepository } from './api/_lib/SupabaseProductRepository';
import { SupabaseShipmentRepository } from './api/_lib/SupabaseShipmentRepository';
import { ProductionOrderRepository } from './api/_lib/ProductionOrderRepository';
import { ProductionOrderSyncService } from './api/_lib/ProductionOrderSyncService';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Body parser
  app.use(express.json());

  // Initialize repositories
  const repository = new SupabaseProductRepository();
  const shipmentRepository = new SupabaseShipmentRepository();
  const productionOrderRepository = new ProductionOrderRepository();
  const productionOrderSyncService = new ProductionOrderSyncService();

  // BFF API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
  app.get('/api/barcode/products', async (req, res) => {
    try {
      const products = await repository.getAllProducts();
      return res.json(products);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to retrieve products list.' });
    }
  });

  /**
   * Add a custom product dynamically for instant play/reprint tests
   */
  app.post('/api/barcode/add', async (req, res) => {
    try {
      const { sku, item_name, mrp, ean_upc, batch_no } = req.body;

      if (!sku || !item_name || !mrp || !ean_upc) {
        return res.status(400).json({ error: 'sku, item_name, mrp, and ean_upc are all required.' });
      }

      const product = await repository.addProduct({ sku, item_name, mrp, ean_upc, batch_no });
      return res.status(201).json(product);
    } catch (error) {
      console.error('[BFF API] Add product error:', error);
      return res.status(500).json({ error: 'Failed to record custom product in repository.' });
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
              sku_name: p.item_name,
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
  app.post('/api/shipment/confirm', async (req, res) => {
    try {
      const { countingQty, planned_mode } = req.body;
      if (!countingQty || typeof countingQty !== 'object') {
        return res.status(400).json({ error: 'countingQty must be a key-value object of scanned counts.' });
      }
      const mode: 'AIR' | 'SEA' = (planned_mode || 'AIR').toString().toUpperCase() === 'SEA' ? 'SEA' : 'AIR';

      const allProducts = await repository.getAllProducts();

      for (const [sku, counted] of Object.entries(countingQty)) {
        if (typeof counted !== 'number' || counted <= 0) continue;

        const prod = allProducts.find(p => p.sku && p.sku.toLowerCase() === sku.toLowerCase());
        const name = prod ? prod.item_name : `Unexpected SKU ${sku}`;
        const prodId = prod ? prod.product_id : null;

        await shipmentRepository.incrementFulfilledQty(sku, name, prodId, counted, mode);
      }

      return res.json({ success: true });
    } catch (error: any) {
      console.error('[BFF API] Session confirmation error:', error);
      return res.status(500).json({ error: error.message || 'Failed to record session quantities into shipment rows.' });
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
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('[BFF Server] Serving production compiled assets from:', distPath);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[BFF Server] Core system listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[BFF Server] Failed to bootstrap application server:', err);
});
