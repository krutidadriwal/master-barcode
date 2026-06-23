import { Pool } from 'pg';
import { Product, ProductMasterSyncResult } from './types.js';

const LOCAL_TABLE = '"EasyEcomProductMaster"';
const CHUNK_SIZE = 500;

export class EasyEcomProductMasterSyncService {
  private centralPool: Pool;
  private localPool: Pool;

  constructor() {
    const centralUrl = process.env.CENTRAL_DB_URL;
    const localUrl = process.env.DATABASE_URL;

    if (!centralUrl) throw new Error('CENTRAL_DB_URL is not configured.');
    if (!localUrl) throw new Error('DATABASE_URL (local) is required for product master sync.');

    this.centralPool = new Pool({
      connectionString: centralUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
      max: 3,
    });

    this.localPool = new Pool({
      connectionString: localUrl,
      ssl: localUrl.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
      max: 3,
    });
  }

  async sync(): Promise<ProductMasterSyncResult> {
    console.log('[ProductMasterSync] Fetching from central database...');
    const central = await this.fetchFromCentral();
    console.log(`[ProductMasterSync] Fetched ${central.length} records from central DB.`);

    return this.applyToLocal(central);
  }

  private async fetchFromCentral(): Promise<Product[]> {
    const client = await this.centralPool.connect();
    try {
      const res = await client.query(`
        SELECT id, product_id, sku, product_name, brand, brand_id, mrp, model_no,
               "EANUPC", accounting_sku, product_image_url, created_at, updated_at
        FROM ${LOCAL_TABLE}
        ORDER BY id
      `);
      return res.rows.map(r => ({
        id: r.id,
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
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
    } finally {
      client.release();
    }
  }

  private async applyToLocal(central: Product[]): Promise<ProductMasterSyncResult> {
    const client = await this.localPool.connect();
    try {
      // Ensure local table and indexes exist
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${LOCAL_TABLE} (
          id VARCHAR(100) PRIMARY KEY,
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
        CREATE INDEX IF NOT EXISTS idx_epm_sku ON ${LOCAL_TABLE} (LOWER(sku));
        CREATE INDEX IF NOT EXISTS idx_epm_product_id ON ${LOCAL_TABLE} (product_id);
        CREATE INDEX IF NOT EXISTS idx_epm_eanupc ON ${LOCAL_TABLE} (LOWER("EANUPC"));
        CREATE INDEX IF NOT EXISTS idx_epm_accounting_sku ON ${LOCAL_TABLE} (LOWER(accounting_sku));
      `);

      if (central.length === 0) {
        const countRes = await client.query(`SELECT COUNT(*) FROM ${LOCAL_TABLE}`);
        return { inserted: 0, updated: 0, deleted: 0, total: parseInt(countRes.rows[0].count) };
      }

      // Snapshot existing IDs before upsert for insert/update counting
      const existingRes = await client.query(`SELECT id FROM ${LOCAL_TABLE}`);
      const existingIds = new Set<string>(existingRes.rows.map((r: any) => String(r.id)));
      const centralIds = central.map(p => p.id!);

      let inserted = 0;
      let updated = 0;

      // Upsert in chunks to avoid oversized queries
      await client.query('BEGIN');
      try {
        for (let i = 0; i < central.length; i += CHUNK_SIZE) {
          const chunk = central.slice(i, i + CHUNK_SIZE);

          const placeholders = chunk.map((_, idx) => {
            const b = idx * 12;
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12})`;
          }).join(',');

          const params = chunk.flatMap(p => [
            p.id, p.product_id, p.sku, p.product_name,
            p.brand ?? null, p.brand_id ?? null, p.mrp,
            p.model_no ?? null, p.EANUPC ?? null, p.accounting_sku ?? null,
            p.product_image_url ?? null, p.updated_at ?? null,
          ]);

          await client.query(`
            INSERT INTO ${LOCAL_TABLE}
              (id, product_id, sku, product_name, brand, brand_id, mrp, model_no,
               "EANUPC", accounting_sku, product_image_url, updated_at)
            VALUES ${placeholders}
            ON CONFLICT (id) DO UPDATE SET
              product_id      = EXCLUDED.product_id,
              sku             = EXCLUDED.sku,
              product_name    = EXCLUDED.product_name,
              brand           = EXCLUDED.brand,
              brand_id        = EXCLUDED.brand_id,
              mrp             = EXCLUDED.mrp,
              model_no        = EXCLUDED.model_no,
              "EANUPC"        = EXCLUDED."EANUPC",
              accounting_sku  = EXCLUDED.accounting_sku,
              product_image_url = EXCLUDED.product_image_url,
              updated_at      = EXCLUDED.updated_at
          `, params);

          for (const p of chunk) {
            if (existingIds.has(p.id!)) updated++;
            else inserted++;
          }
        }

        // Delete local records whose IDs are no longer in the central DB
        let deleted = 0;
        if (centralIds.length > 0) {
          // Build temp table for safe bulk delete
          await client.query(`
            CREATE TEMP TABLE _sync_ids (id VARCHAR(100)) ON COMMIT DROP
          `);
          for (let i = 0; i < centralIds.length; i += CHUNK_SIZE) {
            const chunk = centralIds.slice(i, i + CHUNK_SIZE);
            const ph = chunk.map((_, j) => `($${j + 1})`).join(',');
            await client.query(`INSERT INTO _sync_ids VALUES ${ph}`, chunk);
          }
          const delRes = await client.query(`
            DELETE FROM ${LOCAL_TABLE}
            WHERE id NOT IN (SELECT id FROM _sync_ids)
          `);
          deleted = delRes.rowCount ?? 0;
        }

        await client.query('COMMIT');

        const totalRes = await client.query(`SELECT COUNT(*) FROM ${LOCAL_TABLE}`);
        const total = parseInt(totalRes.rows[0].count);

        console.log(`[ProductMasterSync] Done. Inserted: ${inserted}, Updated: ${updated}, Deleted: ${deleted}, Total: ${total}`);
        return { inserted, updated, deleted, total };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.centralPool.end(), this.localPool.end()]);
  }
}
