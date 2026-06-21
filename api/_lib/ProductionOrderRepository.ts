import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { ProductionOrderRow, SyncResult } from './types';

const TABLE = 'production_order_barcode';

export class ProductionOrderRepository {
  private supabaseClient: SupabaseClient | null = null;
  private pgPool: Pool | null = null;
  private initializedPg = false;

  constructor() {
    const dbUrl = process.env.DATABASE_URL;
    const pgHost = process.env.PGHOST;

    if (dbUrl || pgHost) {
      try {
        if (dbUrl) {
          this.pgPool = new Pool({
            connectionString: dbUrl,
            ssl: dbUrl.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
          });
        } else {
          this.pgPool = new Pool({
            host: pgHost,
            port: parseInt(process.env.PGPORT || '5432'),
            database: process.env.PGDATABASE || 'postgres',
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD,
            ssl: pgHost?.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
          });
        }
        console.log('[PO Repo] PostgreSQL pool initialized.');
      } catch (err) {
        console.error('[PO Repo] Failed to init pg pool:', err);
      }
    }

    if (!this.pgPool) {
      const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      if (supabaseUrl && supabaseKey) {
        try {
          this.supabaseClient = createClient(supabaseUrl, supabaseKey);
          console.log('[PO Repo] Supabase REST client initialized.');
        } catch (err) {
          console.error('[PO Repo] Failed to init Supabase client:', err);
        }
      }
    }

    if (!this.pgPool && !this.supabaseClient) {
      console.warn('[PO Repo] No database configured — production order data will not persist.');
    }
  }

  private async ensureTable(): Promise<void> {
    if (!this.pgPool || this.initializedPg) return;
    this.initializedPg = true;

    const client = await this.pgPool.connect();
    try {
      console.log('[PO Repo] Verifying production_order_barcode table schema...');
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id                      BIGSERIAL PRIMARY KEY,
          reference_code_original VARCHAR(100) NOT NULL,
          reference_code_short    VARCHAR(20)  NOT NULL,
          import_date             DATE,
          order_quantity          INTEGER      NOT NULL DEFAULT 0,
          item_status             VARCHAR(100),
          suborder_quantity       INTEGER      NOT NULL DEFAULT 0,
          item_quantity           INTEGER      NOT NULL DEFAULT 0,
          returned_quantity       INTEGER      NOT NULL DEFAULT 0,
          cancelled_quantity      INTEGER      NOT NULL DEFAULT 0,
          shipped_quantity        INTEGER      NOT NULL DEFAULT 0,
          sku                     VARCHAR(100) NOT NULL,
          sub_product_count       INTEGER      NOT NULL DEFAULT 0,
          product_name            VARCHAR(255),
          brand                   VARCHAR(100),
          model_no                VARCHAR(100),
          ean                     VARCHAR(100),
          size                    VARCHAR(50),
          created_at              TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at              TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (reference_code_original, sku)
        );
      `);
    } finally {
      client.release();
    }
  }

  async upsertOrders(orders: ProductionOrderRow[]): Promise<SyncResult> {
    const result: SyncResult = { imported: 0, updated: 0, skipped: 0, failed: 0 };
    if (!orders.length) return result;

    if (this.pgPool) {
      try {
        await this.ensureTable();
        const client = await this.pgPool.connect();
        try {
          await client.query('BEGIN');
          for (const row of orders) {
            try {
              const res = await client.query(
                `INSERT INTO ${TABLE} (
                  reference_code_original, reference_code_short, import_date,
                  order_quantity, item_status, suborder_quantity, item_quantity,
                  returned_quantity, cancelled_quantity, shipped_quantity,
                  sku, sub_product_count, product_name, brand, model_no, ean, size, updated_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CURRENT_TIMESTAMP)
                ON CONFLICT (reference_code_original, sku)
                DO UPDATE SET
                  reference_code_short = EXCLUDED.reference_code_short,
                  import_date          = EXCLUDED.import_date,
                  order_quantity       = EXCLUDED.order_quantity,
                  item_status          = EXCLUDED.item_status,
                  suborder_quantity    = EXCLUDED.suborder_quantity,
                  item_quantity        = EXCLUDED.item_quantity,
                  returned_quantity    = EXCLUDED.returned_quantity,
                  cancelled_quantity   = EXCLUDED.cancelled_quantity,
                  shipped_quantity     = EXCLUDED.shipped_quantity,
                  sub_product_count    = EXCLUDED.sub_product_count,
                  product_name         = EXCLUDED.product_name,
                  brand                = EXCLUDED.brand,
                  model_no             = EXCLUDED.model_no,
                  ean                  = EXCLUDED.ean,
                  size                 = EXCLUDED.size,
                  updated_at           = CURRENT_TIMESTAMP
                RETURNING (xmax = 0) AS inserted`,
                [
                  row.reference_code_original, row.reference_code_short, row.import_date,
                  row.order_quantity, row.item_status, row.suborder_quantity, row.item_quantity,
                  row.returned_quantity, row.cancelled_quantity, row.shipped_quantity,
                  row.sku, row.sub_product_count, row.product_name, row.brand,
                  row.model_no, row.ean, row.size,
                ]
              );
              const wasInserted = res.rows[0]?.inserted;
              if (wasInserted) result.imported++;
              else result.updated++;
            } catch (rowErr) {
              console.error('[PO Repo] Row upsert failed:', row.reference_code_original, row.sku, rowErr);
              result.failed++;
            }
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
        return result;
      } catch (err) {
        console.error('[PO Repo] PG upsert batch failed:', err);
        throw err;
      }
    }

    if (this.supabaseClient) {
      for (const row of orders) {
        try {
          const { error } = await this.supabaseClient
            .from(TABLE)
            .upsert(
              { ...row, updated_at: new Date().toISOString() },
              { onConflict: 'reference_code_original,sku' }
            );
          if (error) {
            console.error('[PO Repo] Supabase upsert error:', error);
            result.failed++;
          } else {
            result.imported++;
          }
        } catch (err) {
          result.failed++;
        }
      }
      return result;
    }

    throw new Error('No database configured for production order repository.');
  }

  async getAllOrders(): Promise<ProductionOrderRow[]> {
    if (this.pgPool) {
      try {
        await this.ensureTable();
        const res = await this.pgPool.query(
          `SELECT reference_code_original, reference_code_short, import_date,
                  order_quantity, item_status, suborder_quantity, item_quantity,
                  returned_quantity, cancelled_quantity, shipped_quantity,
                  sku, sub_product_count, product_name, brand, model_no, ean, size,
                  created_at, updated_at
           FROM ${TABLE}
           ORDER BY import_date DESC, reference_code_original ASC`
        );
        return res.rows as ProductionOrderRow[];
      } catch (err) {
        console.error('[PO Repo] PG getAllOrders error:', err);
        throw err;
      }
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from(TABLE)
        .select('*')
        .order('import_date', { ascending: false });
      if (error) throw new Error(error.message);
      return (data || []) as ProductionOrderRow[];
    }

    throw new Error('No database configured for production order repository.');
  }
}
