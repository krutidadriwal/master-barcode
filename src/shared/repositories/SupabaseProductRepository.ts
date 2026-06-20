import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { Product } from '../types';

export class SupabaseProductRepository {
  private supabaseClient: SupabaseClient | null = null;
  private pgPool: Pool | null = null;
  private initializedPg = false;
  
  private mockProducts: Product[] = [];

  constructor() {
    // Check for PostgreSQL Direct Connection parameters
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

    // Check for standard Supabase REST parameters as fallback/alternative
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

  /**
   * Lazily verifies that the postgres tables are present and ready to go.
   */
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
        `);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[BFF] Failed to sync database schema:", err);
    }
  }

  /**
   * Searches for matching product.
   * Search priority:
   * 1. ean_upc
   * 2. sku
   * 3. product_id
   */
  async searchProduct(identifier: string): Promise<Product | null> {
    const query = identifier.trim();
    if (!query) return null;

    // 1. Direct PG connection check
    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `SELECT product_id, sku, item_name, mrp, ean_upc, batch_no 
           FROM products 
           WHERE LOWER(ean_upc) = LOWER($1) 
              OR LOWER(sku) = LOWER($1) 
              OR LOWER(product_id) = LOWER($1) 
           LIMIT 1`,
          [query]
        );

        if (res.rows && res.rows.length > 0) {
          console.log(`[BFF Direct PG] [SUCCESS] Successfully fetched product "${query}" from Supabase:`, res.rows[0]);
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
        console.error("[BFF Direct PG] Failed to fetch product via Postgres client:", err);
      }
    }

    // 2. Supabase SDK Client check
    if (this.supabaseClient) {
      try {
        const { data, error } = await this.supabaseClient
          .from('products')
          .select('product_id, sku, item_name, mrp, ean_upc, batch_no')
          .or(`ean_upc.eq."${query}",sku.eq."${query}",product_id.eq."${query}"`)
          .maybeSingle();

        if (error) {
          console.error("[BFF REST] Supabase REST query exception:", error);
        } else if (data) {
          console.log(`[BFF REST] [SUCCESS] Successfully fetched product "${query}" from Supabase REST client:`, data);
          return {
            product_id: data.product_id || '',
            sku: data.sku || '',
            item_name: data.item_name || '',
            mrp: data.mrp || '',
            ean_upc: data.ean_upc || '',
            batch_no: data.batch_no || undefined
          };
        }
      } catch (err) {
        console.error("[BFF REST] Exception querying Supabase client SDK:", err);
      }
    }

    // Fallback search inside mock local catalog (Memory Registry sandbox)
    const cleanQuery = query.toLowerCase();

    // 1. Search ean_upc
    let match = this.mockProducts.find(p => p.ean_upc.toLowerCase() === cleanQuery);
    if (match) return match;

    // 2. Search sku
    match = this.mockProducts.find(p => p.sku.toLowerCase() === cleanQuery);
    if (match) return match;

    // 3. Search product_id
    match = this.mockProducts.find(p => p.product_id.toLowerCase() === cleanQuery);
    if (match) return match;

    return null;
  }

  /**
   * Inserts or appends products on-the-fly inside the active container.
   * Makes local and cloud sandbox highly interactive.
   */
  async addProduct(product: Omit<Product, 'product_id'>): Promise<Product> {
    const newProduct: Product = {
      product_id: `prod-dyn-${Date.now()}`,
      sku: product.sku.trim(),
      item_name: product.item_name.trim(),
      mrp: product.mrp.trim(),
      ean_upc: product.ean_upc.trim(),
      batch_no: product.batch_no ? product.batch_no.trim() : undefined
    };

    // 1. Direct PG Connection check
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

    // 2. Supabase Client SDK Check
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

    // Fallback to local sandbox memory array
    this.mockProducts.push(newProduct);
    return newProduct;
  }

  /**
   * Retrieves current product catalog.
   */
  async getAllProducts(): Promise<Product[]> {
    // 1. Direct PG connection check
    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `SELECT product_id, sku, item_name, mrp, ean_upc, batch_no 
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
            batch_no: row.batch_no || undefined
          }));
        }
      } catch (err) {
        console.error("[BFF Direct PG] Failed to fetch all products:", err);
      }
    }

    // 2. Supabase SDK Client check
    if (this.supabaseClient) {
      try {
        const { data, error } = await this.supabaseClient
          .from('products')
          .select('product_id, sku, item_name, mrp, ean_upc, batch_no')
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
