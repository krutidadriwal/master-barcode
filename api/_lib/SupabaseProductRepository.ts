import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { Product } from './types.js';

const TABLE = '"EasyEcomProductMaster"';

export class SupabaseProductRepository {
  private supabaseClient: SupabaseClient | null = null;
  private pgPool: Pool | null = null;
  private initializedPg = false;

  private mockProducts: Product[] = [];

  constructor() {
    const dbUrl = process.env.DATABASE_URL;
    const pgHost = process.env.PGHOST;

    if (dbUrl || pgHost) {
      try {
        console.log("[BFF] PostgreSQL direct database connection detected. Initializing pg Pool...");
        if (dbUrl) {
          this.pgPool = new Pool({
            connectionString: dbUrl,
            ssl: dbUrl.includes('supabase.co') ? { rejectUnauthorized: false } : undefined
          });
        } else {
          this.pgPool = new Pool({
            host: pgHost,
            port: parseInt(process.env.PGPORT || '5432'),
            database: process.env.PGDATABASE || 'postgres',
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD,
            ssl: (pgHost && pgHost.includes('supabase.co')) ? { rejectUnauthorized: false } : undefined
          });
        }
        console.log("[BFF] PostgreSQL direct database connection pool created.");
      } catch (err) {
        console.error("[BFF] Failed to initialize PostgreSQL pool connection:", err);
      }
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (supabaseUrl && supabaseKey && !this.pgPool) {
      try {
        this.supabaseClient = createClient(supabaseUrl, supabaseKey);
        console.log("[BFF] Supabase REST API client successfully initialized.");
      } catch (err) {
        console.error("[BFF] Failed to construct Supabase REST client:", err);
      }
    }

    if (!this.pgPool && !this.supabaseClient) {
      console.log("[BFF] No database keys present. Running in local high-performance persistent in-memory sandbox mode.");
    }
  }

  private async ensurePgTable(): Promise<void> {
    if (!this.pgPool || this.initializedPg) return;

    try {
      this.initializedPg = true;
      const client = await this.pgPool.connect();
      try {
        console.log("[BFF] Syncing schema: verifying EasyEcomProductMaster table exists...");
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${TABLE} (
            id VARCHAR(200) PRIMARY KEY,
            product_id VARCHAR(200) UNIQUE NOT NULL,
            sku VARCHAR(200) UNIQUE NOT NULL,
            product_name VARCHAR(500) NOT NULL DEFAULT '',
            brand VARCHAR(200),
            brand_id VARCHAR(100),
            mrp VARCHAR(100) NOT NULL DEFAULT '',
            model_no VARCHAR(200),
            "EANUPC" VARCHAR(200),
            accounting_sku VARCHAR(200),
            product_image_url TEXT,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
          );
          CREATE INDEX IF NOT EXISTS idx_epm_sku ON ${TABLE} (LOWER(sku));
          CREATE INDEX IF NOT EXISTS idx_epm_product_id ON ${TABLE} (product_id);
          CREATE INDEX IF NOT EXISTS idx_epm_eanupc ON ${TABLE} (LOWER("EANUPC"));
          CREATE INDEX IF NOT EXISTS idx_epm_accounting_sku ON ${TABLE} (LOWER(accounting_sku));
        `);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[BFF] Failed to sync database schema:", err);
    }
  }

  private rowToProduct(r: any): Product {
    return {
      id: r.id ? String(r.id) : undefined,
      product_id: r.product_id || '',
      sku: r.sku || '',
      product_name: r.product_name || '',
      brand: r.brand || undefined,
      brand_id: r.brand_id != null ? String(r.brand_id) : undefined,
      mrp: r.mrp || '',
      model_no: r.model_no || undefined,
      EANUPC: r.EANUPC || undefined,
      accounting_sku: r.accounting_sku || undefined,
      product_image_url: r.product_image_url || undefined,
      created_at: r.created_at || undefined,
      updated_at: r.updated_at || undefined,
    };
  }

  async searchProduct(identifier: string): Promise<Product | null> {
    const query = identifier.trim();
    if (!query) return null;

    // PG: single query, exact SKU match wins via ORDER BY
    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `SELECT id, product_id, sku, product_name, brand, brand_id, mrp, model_no,
                  "EANUPC", accounting_sku, product_image_url, created_at, updated_at
           FROM ${TABLE}
           WHERE LOWER(sku) = LOWER($1)
              OR LOWER("EANUPC") = LOWER($1)
              OR LOWER(COALESCE(accounting_sku, '')) = LOWER($1)
              OR LOWER(COALESCE(model_no, '')) = LOWER($1)
              OR LOWER(product_id) = LOWER($1)
           ORDER BY CASE WHEN LOWER(sku) = LOWER($1) THEN 0 ELSE 1 END
           LIMIT 1`,
          [query]
        );

        if (res.rows && res.rows.length > 0) {
          console.log(`[BFF Direct PG] [SUCCESS] Fetched product "${query}":`, res.rows[0].sku);
          return this.rowToProduct(res.rows[0]);
        }
      } catch (err) {
        console.error("[BFF Direct PG] Failed to fetch product:", err);
      }
    }

    // Supabase REST: SKU exact match first, EAN/other fallback second
    if (this.supabaseClient) {
      try {
        const skuRes = await this.supabaseClient
          .from('EasyEcomProductMaster')
          .select('id, product_id, sku, product_name, brand, brand_id, mrp, model_no, EANUPC, accounting_sku, product_image_url, created_at, updated_at')
          .filter('sku', 'ilike', query)
          .maybeSingle();

        const row = skuRes.data ?? (
          await this.supabaseClient
            .from('EasyEcomProductMaster')
            .select('id, product_id, sku, product_name, brand, brand_id, mrp, model_no, EANUPC, accounting_sku, product_image_url, created_at, updated_at')
            .or(`EANUPC.eq."${query}",accounting_sku.eq."${query}",model_no.eq."${query}",product_id.eq."${query}"`)
            .maybeSingle()
        ).data;

        if (row) {
          console.log(`[BFF REST] [SUCCESS] Fetched product "${query}":`, row.sku);
          return this.rowToProduct(row);
        }
      } catch (err) {
        console.error("[BFF REST] Exception querying Supabase client SDK:", err);
      }
    }

    // Mock in-memory fallback — SKU exact match first
    const q = query.toLowerCase();
    const mockMatch =
      this.mockProducts.find(p => p.sku.toLowerCase() === q) ||
      this.mockProducts.find(p => (p.EANUPC || '').toLowerCase() === q) ||
      this.mockProducts.find(p => (p.accounting_sku || '').toLowerCase() === q) ||
      this.mockProducts.find(p => (p.model_no || '').toLowerCase() === q) ||
      this.mockProducts.find(p => p.product_id.toLowerCase() === q);

    return mockMatch || null;
  }

  async addProduct(input: { sku: string; item_name: string; mrp: string; ean_upc: string; batch_no?: string }): Promise<Product> {
    await this.ensurePgTable();
    const productId = `CUSTOM-${input.sku}`;
    const now = new Date().toISOString();

    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        const res = await client.query(
          `INSERT INTO ${TABLE}
             (id, product_id, sku, product_name, mrp, "EANUPC", model_no, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
           ON CONFLICT (sku) DO UPDATE SET
             product_name = EXCLUDED.product_name,
             mrp          = EXCLUDED.mrp,
             "EANUPC"     = EXCLUDED."EANUPC",
             model_no     = EXCLUDED.model_no,
             updated_at   = EXCLUDED.updated_at
           RETURNING id, product_id, sku, product_name, brand, brand_id, mrp, model_no,
                     "EANUPC", accounting_sku, product_image_url, created_at, updated_at`,
          [productId, productId, input.sku, input.item_name, input.mrp, input.ean_upc || null, input.batch_no || null, now]
        );
        return this.rowToProduct(res.rows[0]);
      } finally {
        client.release();
      }
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from('EasyEcomProductMaster')
        .upsert({
          id: productId, product_id: productId, sku: input.sku,
          product_name: input.item_name, mrp: input.mrp,
          EANUPC: input.ean_upc || null, model_no: input.batch_no || null,
          created_at: now, updated_at: now,
        }, { onConflict: 'sku' })
        .select()
        .single();
      if (error) throw error;
      return this.rowToProduct(data);
    }

    // Mock fallback
    const product: Product = {
      id: productId, product_id: productId, sku: input.sku,
      product_name: input.item_name, mrp: input.mrp,
      EANUPC: input.ean_upc || undefined, model_no: input.batch_no || undefined,
      created_at: now, updated_at: now,
    };
    this.mockProducts.push(product);
    return product;
  }

  async getAllProducts(): Promise<Product[]> {
    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `SELECT id, product_id, sku, product_name, brand, brand_id, mrp, model_no,
                  "EANUPC", accounting_sku, product_image_url, created_at, updated_at
           FROM ${TABLE}
           ORDER BY product_name ASC`
        );
        if (res.rows) {
          console.log(`[BFF Direct PG] [SUCCESS] Fetched all ${res.rows.length} products.`);
          return res.rows.map((r: any) => this.rowToProduct(r));
        }
      } catch (err) {
        console.error("[BFF Direct PG] Failed to fetch all products:", err);
      }
    }

    if (this.supabaseClient) {
      try {
        const { data, error } = await this.supabaseClient
          .from('EasyEcomProductMaster')
          .select('id, product_id, sku, product_name, brand, brand_id, mrp, model_no, EANUPC, accounting_sku, product_image_url, created_at, updated_at')
          .order('product_name', { ascending: true });

        if (error) {
          console.error("[BFF REST] Supabase REST query all products exception:", error);
        } else if (data) {
          console.log(`[BFF REST] [SUCCESS] Fetched all ${data.length} products.`);
          return data.map((r: any) => this.rowToProduct(r));
        }
      } catch (err) {
        console.error("[BFF REST] Exception querying all products:", err);
      }
    }

    return this.mockProducts;
  }
}
