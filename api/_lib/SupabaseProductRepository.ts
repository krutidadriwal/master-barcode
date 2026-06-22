import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { Product } from './types';

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
        console.log("[BFF] Syncing schema: verifying 'products' table exists...");
        await client.query(`
          CREATE TABLE IF NOT EXISTS products (
            product_id VARCHAR(100) PRIMARY KEY,
            sku VARCHAR(100) UNIQUE NOT NULL,
            item_name VARCHAR(255) NOT NULL,
            mrp VARCHAR(50) NOT NULL,
            ean_upc VARCHAR(100) NOT NULL
          );
          ALTER TABLE products ADD COLUMN IF NOT EXISTS batch_no VARCHAR(100);
          ALTER TABLE products ADD COLUMN IF NOT EXISTS article_number VARCHAR(100);
          ALTER TABLE products ADD COLUMN IF NOT EXISTS model_no VARCHAR(100);
        `);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[BFF] Failed to sync database schema:", err);
    }
  }

  private extractSkuBase(sku: string): string {
    return sku.replace(/[^0-9]+$/i, '');
  }

  // Aggregates the best available custom_ean and ean_upc from all siblings in one query.
  private async findSiblingEan(sku: string): Promise<Pick<Product, 'ean_upc' | 'custom_ean'> | null> {
    const base = this.extractSkuBase(sku);
    if (!base) return null;

    if (this.pgPool) {
      try {
        const res = await this.pgPool.query(
          `SELECT
             MAX(CASE WHEN COALESCE(custom_ean, '') != '' THEN custom_ean END) AS custom_ean,
             MAX(CASE WHEN COALESCE(ean_upc, '') != '' THEN ean_upc END) AS ean_upc
           FROM products
           WHERE REGEXP_REPLACE(sku, '[^0-9]+$', '') = $1
             AND LOWER(sku) != LOWER($2)`,
          [base, sku]
        );
        const row = res.rows?.[0];
        if (row?.custom_ean || row?.ean_upc) {
          return { custom_ean: row.custom_ean || undefined, ean_upc: row.ean_upc || '' };
        }
      } catch (err) {
        console.error('[BFF Direct PG] Sibling EAN lookup failed:', err);
      }
    }

    if (this.supabaseClient) {
      try {
        const { data } = await this.supabaseClient
          .from('products')
          .select('sku, ean_upc, custom_ean')
          .like('sku', `${base}%`)
          .limit(20);
        const siblings = data?.filter(
          p => this.extractSkuBase(p.sku) === base && p.sku.toLowerCase() !== sku.toLowerCase()
        ) ?? [];
        const siblingCustomEan = siblings.find(p => p.custom_ean?.trim())?.custom_ean;
        const siblingEanUpc = siblings.find(p => p.ean_upc?.trim())?.ean_upc;
        if (siblingCustomEan || siblingEanUpc) {
          return { custom_ean: siblingCustomEan || undefined, ean_upc: siblingEanUpc || '' };
        }
      } catch (err) {
        console.error('[BFF REST] Sibling EAN lookup failed:', err);
      }
    }

    const siblings = this.mockProducts.filter(
      p => this.extractSkuBase(p.sku) === base && p.sku.toLowerCase() !== sku.toLowerCase()
    );
    const siblingCustomEan = siblings.find(p => p.custom_ean?.trim())?.custom_ean;
    const siblingEanUpc = siblings.find(p => p.ean_upc?.trim())?.ean_upc;
    if (siblingCustomEan || siblingEanUpc) {
      return { custom_ean: siblingCustomEan || undefined, ean_upc: siblingEanUpc || '' };
    }
    return null;
  }

  // Fills missing custom_ean and ean_upc independently from siblings.
  // Priority per field: own value → sibling value. BarcodePreview then applies custom_ean → ean_upc → sku.
  private async fillSiblingEan(product: Product): Promise<Product> {
    const needsCustomEan = !product.custom_ean?.trim();
    const needsEanUpc = !product.ean_upc?.trim();
    if (!needsCustomEan && !needsEanUpc) return product;

    const sibling = await this.findSiblingEan(product.sku);
    if (!sibling) return product;

    return {
      ...product,
      ...(needsCustomEan && sibling.custom_ean ? { custom_ean: sibling.custom_ean } : {}),
      ...(needsEanUpc && sibling.ean_upc ? { ean_upc: sibling.ean_upc } : {}),
    };
  }

  async searchProduct(identifier: string): Promise<Product | null> {
    const query = identifier.trim();
    if (!query) return null;

    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `SELECT product_id, sku, item_name, mrp, ean_upc, custom_ean, batch_no, article_number, model_no
           FROM products
           WHERE LOWER(ean_upc) = LOWER($1)
              OR LOWER(COALESCE(custom_ean, '')) = LOWER($1)
              OR LOWER(sku) = LOWER($1)
              OR LOWER(product_id) = LOWER($1)
              OR LOWER(COALESCE(article_number, '')) = LOWER($1)
              OR LOWER(COALESCE(model_no, '')) = LOWER($1)
           LIMIT 1`,
          [query]
        );

        if (res.rows && res.rows.length > 0) {
          console.log(`[BFF Direct PG] [SUCCESS] Successfully fetched product "${query}" from Supabase:`, res.rows[0]);
          return this.fillSiblingEan({
            product_id: res.rows[0].product_id || '',
            sku: res.rows[0].sku || '',
            item_name: res.rows[0].item_name || '',
            mrp: res.rows[0].mrp || '',
            ean_upc: res.rows[0].ean_upc || '',
            custom_ean: res.rows[0].custom_ean || undefined,
            batch_no: res.rows[0].batch_no || undefined,
            article_number: res.rows[0].article_number || undefined,
            model_no: res.rows[0].model_no || undefined,
          });
        }
      } catch (err) {
        console.error("[BFF Direct PG] Failed to fetch product via Postgres client:", err);
      }
    }

    if (this.supabaseClient) {
      try {
        const { data, error } = await this.supabaseClient
          .from('products')
          .select('product_id, sku, item_name, mrp, ean_upc, custom_ean, batch_no, article_number, model_no')
          .or(`ean_upc.eq."${query}",custom_ean.eq."${query}",sku.eq."${query}",product_id.eq."${query}",article_number.eq."${query}",model_no.eq."${query}"`)
          .maybeSingle();

        if (error) {
          console.error("[BFF REST] Supabase REST query exception:", error);
        } else if (data) {
          console.log(`[BFF REST] [SUCCESS] Successfully fetched product "${query}" from Supabase REST client:`, data);
          return this.fillSiblingEan({
            product_id: data.product_id || '',
            sku: data.sku || '',
            item_name: data.item_name || '',
            mrp: data.mrp || '',
            ean_upc: data.ean_upc || '',
            custom_ean: data.custom_ean || undefined,
            batch_no: data.batch_no || undefined,
            article_number: data.article_number || undefined,
            model_no: data.model_no || undefined,
          });
        }
      } catch (err) {
        console.error("[BFF REST] Exception querying Supabase client SDK:", err);
      }
    }

    const cleanQuery = query.toLowerCase();
    let match = this.mockProducts.find(p => p.ean_upc.toLowerCase() === cleanQuery);
    if (match) return this.fillSiblingEan(match);
    match = this.mockProducts.find(p => p.sku.toLowerCase() === cleanQuery);
    if (match) return this.fillSiblingEan(match);
    match = this.mockProducts.find(p => p.product_id.toLowerCase() === cleanQuery);
    if (match) return this.fillSiblingEan(match);
    match = this.mockProducts.find(p => p.custom_ean?.toLowerCase() === cleanQuery);
    if (match) return this.fillSiblingEan(match);
    match = this.mockProducts.find(p => p.article_number?.toLowerCase() === cleanQuery);
    if (match) return this.fillSiblingEan(match);
    match = this.mockProducts.find(p => p.model_no?.toLowerCase() === cleanQuery);
    if (match) return this.fillSiblingEan(match);
    return null;
  }

  async addProduct(product: Omit<Product, 'product_id'>): Promise<Product> {
    const newProduct: Product = {
      product_id: `prod-dyn-${Date.now()}`,
      sku: product.sku.trim(),
      item_name: product.item_name.trim(),
      mrp: product.mrp.trim(),
      ean_upc: product.ean_upc.trim(),
      batch_no: product.batch_no ? product.batch_no.trim() : undefined
    };

    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `INSERT INTO products (product_id, sku, item_name, mrp, ean_upc, batch_no)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (sku)
           DO UPDATE SET item_name = EXCLUDED.item_name, mrp = EXCLUDED.mrp, ean_upc = EXCLUDED.ean_upc, batch_no = EXCLUDED.batch_no
           RETURNING *`,
          [newProduct.product_id, newProduct.sku, newProduct.item_name, newProduct.mrp, newProduct.ean_upc, newProduct.batch_no || null]
        );
        if (res.rows && res.rows.length > 0) {
          console.log("[BFF Direct PG] [SUCCESS] Successfully inserted product to Supabase:", res.rows[0]);
          return {
            product_id: res.rows[0].product_id || '',
            sku: res.rows[0].sku || '',
            item_name: res.rows[0].item_name || '',
            mrp: res.rows[0].mrp || '',
            ean_upc: res.rows[0].ean_upc || '',
            batch_no: res.rows[0].batch_no || undefined
          };
        }
      } catch (err) {
        console.error("[BFF Direct PG] Failed to write custom product node:", err);
      }
    }

    if (this.supabaseClient) {
      try {
        const { data, error } = await this.supabaseClient
          .from('products')
          .insert(newProduct)
          .select()
          .single();
        if (!error && data) {
          console.log("[BFF REST] [SUCCESS] Successfully inserted product to Supabase REST client:", data);
          return data as Product;
        }
      } catch (err) {
        console.error("[BFF REST] Supabase write failed, falling back:", err);
      }
    }

    this.mockProducts.push(newProduct);
    return newProduct;
  }

  async getAllProducts(): Promise<Product[]> {
    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `SELECT product_id, sku, item_name, mrp, ean_upc, custom_ean, batch_no, article_number, model_no
           FROM products
           ORDER BY item_name ASC`
        );
        if (res.rows) {
          console.log(`[BFF Direct PG] [SUCCESS] Successfully fetched all ${res.rows.length} products from Supabase.`);
          return res.rows.map(row => ({
            product_id: row.product_id || '',
            sku: row.sku || '',
            item_name: row.item_name || '',
            mrp: row.mrp || '',
            ean_upc: row.ean_upc || '',
            custom_ean: row.custom_ean || undefined,
            batch_no: row.batch_no || undefined,
            article_number: row.article_number || undefined,
            model_no: row.model_no || undefined,
          }));
        }
      } catch (err) {
        console.error("[BFF Direct PG] Failed to fetch all products:", err);
      }
    }

    if (this.supabaseClient) {
      try {
        const { data, error } = await this.supabaseClient
          .from('products')
          .select('product_id, sku, item_name, mrp, ean_upc, custom_ean, batch_no, article_number, model_no')
          .order('item_name', { ascending: true });

        if (error) {
          console.error("[BFF REST] Supabase REST query all products exception:", error);
        } else if (data) {
          console.log(`[BFF REST] [SUCCESS] Successfully fetched all ${data.length} products from Supabase REST client.`);
          return data as Product[];
        }
      } catch (err) {
        console.error("[BFF REST] Exception querying Supabase client SDK for all products:", err);
      }
    }

    return this.mockProducts;
  }
}
