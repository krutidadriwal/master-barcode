import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { Product } from './types.js';

// ── Table identifiers ────────────────────────────────────────────────────────

/** Central DB table (quoted because of mixed case) */
const CENTRAL_TABLE = '"EasyEcomProductMaster"';
/** Local Supabase table populated by the App Script sync */
const BARCODE_TABLE = 'barcode_product_master';

export class SupabaseProductRepository {
  private supabaseClient: SupabaseClient | null = null;
  private pgPool: Pool | null = null;
  private initializedPg = false;
  private initializedBarcodeTable = false;
  private initializedSettings = false;

  private mockProducts: Product[] = [];

  constructor() {
    const dbUrl  = process.env.DATABASE_URL;
    const pgHost = process.env.PGHOST;

    if (dbUrl || pgHost) {
      try {
        console.log('[BFF] PostgreSQL direct database connection detected. Initializing pg Pool...');
        if (dbUrl) {
          this.pgPool = new Pool({
            connectionString: dbUrl,
            ssl: dbUrl.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
          });
        } else {
          this.pgPool = new Pool({
            host:     pgHost,
            port:     parseInt(process.env.PGPORT || '5432'),
            database: process.env.PGDATABASE || 'postgres',
            user:     process.env.PGUSER     || 'postgres',
            password: process.env.PGPASSWORD,
            ssl: (pgHost && pgHost.includes('supabase.co')) ? { rejectUnauthorized: false } : undefined,
          });
        }
        console.log('[BFF] PostgreSQL direct database connection pool created.');
      } catch (err) {
        console.error('[BFF] Failed to initialize PostgreSQL pool connection:', err);
      }
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (supabaseUrl && supabaseKey && !this.pgPool) {
      try {
        this.supabaseClient = createClient(supabaseUrl, supabaseKey);
        console.log('[BFF] Supabase REST API client successfully initialized.');
      } catch (err) {
        console.error('[BFF] Failed to construct Supabase REST client:', err);
      }
    }

    if (!this.pgPool && !this.supabaseClient) {
      console.log('[BFF] No database keys present. Running in local high-performance persistent in-memory sandbox mode.');
    }
  }

  // ── Feature flag ──────────────────────────────────────────────────────────

  private get useBarcodeTable(): boolean {
    return (process.env.APP_SCRIPT_FOR_BARCODE ?? '').trim() === 'true';
  }

  // ── Schema helpers ────────────────────────────────────────────────────────

  private async ensurePgTable(): Promise<void> {
    if (!this.pgPool || this.initializedPg) return;
    this.initializedPg = true;
    try {
      const client = await this.pgPool.connect();
      try {
        console.log('[BFF] Syncing schema: verifying EasyEcomProductMaster table exists...');
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${CENTRAL_TABLE} (
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
          CREATE INDEX IF NOT EXISTS idx_epm_sku ON ${CENTRAL_TABLE} (LOWER(sku));
          CREATE INDEX IF NOT EXISTS idx_epm_product_id ON ${CENTRAL_TABLE} (product_id);
          CREATE INDEX IF NOT EXISTS idx_epm_eanupc ON ${CENTRAL_TABLE} (LOWER("EANUPC"));
          CREATE INDEX IF NOT EXISTS idx_epm_accounting_sku ON ${CENTRAL_TABLE} (LOWER(accounting_sku));
        `);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[BFF] Failed to sync database schema:', err);
    }
  }

  private async ensureBarcodeTable(): Promise<void> {
    if (!this.pgPool || this.initializedBarcodeTable) return;
    this.initializedBarcodeTable = true;
    try {
      const client = await this.pgPool.connect();
      try {
        console.log('[BFF] Syncing schema: verifying barcode_product_master table exists...');
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${BARCODE_TABLE} (
            sku             TEXT PRIMARY KEY,
            product_id      TEXT,
            item_name       TEXT NOT NULL DEFAULT '',
            product_type    TEXT,
            brand           TEXT,
            colour          TEXT,
            brand_id        TEXT,
            mrp             TEXT NOT NULL DEFAULT '',
            category_name   TEXT,
            cost            TEXT,
            mrp_in_ee       TEXT,
            model_no        TEXT,
            ean_upc         TEXT,
            article_number  TEXT,
            custom_ean      TEXT,
            barcode         TEXT,
            sku_for_barcode TEXT,
            mom             TEXT,
            batch_no        TEXT,
            inventory       TEXT,
            updated_at      TIMESTAMPTZ,
            synced_at       TIMESTAMPTZ DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS idx_bpm_sku        ON ${BARCODE_TABLE} (LOWER(sku));
          CREATE INDEX IF NOT EXISTS idx_bpm_ean_upc    ON ${BARCODE_TABLE} (LOWER(ean_upc));
          CREATE INDEX IF NOT EXISTS idx_bpm_custom_ean ON ${BARCODE_TABLE} (LOWER(custom_ean));
          CREATE INDEX IF NOT EXISTS idx_bpm_model_no   ON ${BARCODE_TABLE} (LOWER(model_no));
          ALTER TABLE ${BARCODE_TABLE} ADD COLUMN IF NOT EXISTS inventory   TEXT;
          ALTER TABLE ${BARCODE_TABLE} ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ;
        `);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[BFF] Failed to ensure barcode_product_master table:', err);
    }
  }

  // ── Row mappers ───────────────────────────────────────────────────────────

  private rowToProduct(r: any): Product {
    return {
      id:                r.id         ? String(r.id) : undefined,
      product_id:        r.product_id || '',
      sku:               r.sku        || '',
      product_name:      r.product_name || '',
      brand:             r.brand      || undefined,
      brand_id:          r.brand_id   != null ? String(r.brand_id) : undefined,
      mrp:               r.mrp        || '',
      model_no:          r.model_no   || undefined,
      EANUPC:            r.EANUPC     || undefined,
      accounting_sku:    r.accounting_sku || undefined,
      product_image_url: r.product_image_url || undefined,
      created_at:        r.created_at || undefined,
      updated_at:        r.updated_at || undefined,
    };
  }

  private rowToProductFromBarcodeTable(r: any): Product {
    // Prefer custom_ean as the EANUPC value if it is non-empty/non-'0'
    const effectiveEan =
      r.custom_ean && String(r.custom_ean).trim() && String(r.custom_ean).trim() !== '0'
        ? String(r.custom_ean).trim()
        : (r.ean_upc ? String(r.ean_upc).trim() : undefined);

    return {
      id:             r.sku,
      product_id:     r.product_id || r.sku || '',
      sku:            r.sku        || '',
      product_name:   r.item_name  || '',
      brand:          r.brand      || undefined,
      brand_id:       r.brand_id   ? String(r.brand_id) : undefined,
      mrp:            String(r.mrp || ''),
      model_no:       r.model_no   || undefined,
      EANUPC:         effectiveEan || undefined,
      accounting_sku: r.sku_for_barcode || undefined,
      created_at:     r.synced_at  || undefined,
      updated_at:     r.synced_at  || undefined,
    };
  }

  // ── searchProduct ─────────────────────────────────────────────────────────

  async searchProduct(identifier: string): Promise<Product | null> {
    const query = identifier.trim();
    if (!query) return null;

    if (this.useBarcodeTable) {
      return this._searchProductInBarcodeTable(query);
    }

    // ── Central DB path (existing) ──
    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `SELECT id, product_id, sku, product_name, brand, brand_id, mrp, model_no,
                  "EANUPC", accounting_sku, product_image_url, created_at, updated_at
           FROM ${CENTRAL_TABLE}
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
        console.error('[BFF Direct PG] Failed to fetch product:', err);
      }
    }

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
        console.error('[BFF REST] Exception querying Supabase client SDK:', err);
      }
    }

    const q = query.toLowerCase();
    const mockMatch =
      this.mockProducts.find(p => p.sku.toLowerCase() === q) ||
      this.mockProducts.find(p => (p.EANUPC || '').toLowerCase() === q) ||
      this.mockProducts.find(p => (p.accounting_sku || '').toLowerCase() === q) ||
      this.mockProducts.find(p => (p.model_no || '').toLowerCase() === q) ||
      this.mockProducts.find(p => p.product_id.toLowerCase() === q);

    return mockMatch || null;
  }

  private async _searchProductInBarcodeTable(query: string): Promise<Product | null> {
    if (this.pgPool) {
      try {
        await this.ensureBarcodeTable();
        const res = await this.pgPool.query(
          `SELECT * FROM ${BARCODE_TABLE}
           WHERE LOWER(sku) = LOWER($1)
              OR LOWER(COALESCE(ean_upc, ''))    = LOWER($1)
              OR LOWER(COALESCE(custom_ean, '')) = LOWER($1)
              OR LOWER(COALESCE(model_no, ''))   = LOWER($1)
              OR LOWER(COALESCE(product_id, '')) = LOWER($1)
           ORDER BY CASE WHEN LOWER(sku) = LOWER($1) THEN 0 ELSE 1 END
           LIMIT 1`,
          [query]
        );
        if (res.rows && res.rows.length > 0) {
          console.log(`[BFF Barcode PG] [SUCCESS] Fetched product "${query}":`, res.rows[0].sku);
          return this.rowToProductFromBarcodeTable(res.rows[0]);
        }
      } catch (err) {
        console.error('[BFF Barcode PG] Failed to fetch product:', err);
      }
    }

    if (this.supabaseClient) {
      try {
        const skuRes = await this.supabaseClient
          .from(BARCODE_TABLE)
          .select('*')
          .filter('sku', 'ilike', query)
          .maybeSingle();

        const row = skuRes.data ?? (
          await this.supabaseClient
            .from(BARCODE_TABLE)
            .select('*')
            .or(`ean_upc.ilike.${query},custom_ean.ilike.${query},model_no.ilike.${query},product_id.ilike.${query}`)
            .maybeSingle()
        ).data;

        if (row) {
          console.log(`[BFF Barcode REST] [SUCCESS] Fetched product "${query}":`, row.sku);
          return this.rowToProductFromBarcodeTable(row);
        }
      } catch (err) {
        console.error('[BFF Barcode REST] Failed to fetch product:', err);
      }
    }

    return null;
  }

  // ── addProduct ────────────────────────────────────────────────────────────

  async addProduct(input: { sku: string; item_name: string; mrp: string; ean_upc: string; batch_no?: string }): Promise<Product> {
    await this.ensurePgTable();
    const productId = `CUSTOM-${input.sku}`;
    const now       = new Date().toISOString();

    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        const res = await client.query(
          `INSERT INTO ${CENTRAL_TABLE}
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

    const product: Product = {
      id: productId, product_id: productId, sku: input.sku,
      product_name: input.item_name, mrp: input.mrp,
      EANUPC: input.ean_upc || undefined, model_no: input.batch_no || undefined,
      created_at: now, updated_at: now,
    };
    this.mockProducts.push(product);
    return product;
  }

  // ── findProductsByEANUPC ──────────────────────────────────────────────────

  async findProductsByEANUPC(ean: string): Promise<Product[]> {
    const query = ean.trim();
    if (!query) return [];

    if (this.useBarcodeTable) {
      return this._findByEANInBarcodeTable(query);
    }

    // ── Central DB path ──
    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `SELECT id, product_id, sku, product_name, brand, brand_id, mrp, model_no,
                  "EANUPC", accounting_sku, product_image_url, created_at, updated_at
           FROM ${CENTRAL_TABLE}
           WHERE LOWER(TRIM(COALESCE("EANUPC", ''))) = LOWER($1)`,
          [query]
        );
        const found = (res.rows || []).map((r: any) => this.rowToProduct(r));
        console.log(`[BFF Direct PG] findProductsByEANUPC("${query}"): ${found.length} row(s) — SKUs: [${found.map(p => p.sku).join(', ')}]`);
        return found;
      } catch (err) {
        console.error('[BFF Direct PG] findProductsByEANUPC failed:', err);
      }
    }

    if (this.supabaseClient) {
      try {
        const { data, error } = await this.supabaseClient
          .from('EasyEcomProductMaster')
          .select('id, product_id, sku, product_name, brand, brand_id, mrp, model_no, EANUPC, accounting_sku, product_image_url, created_at, updated_at')
          .ilike('EANUPC', query);
        if (!error && data) {
          const found = data.map((r: any) => this.rowToProduct(r));
          console.log(`[BFF REST] findProductsByEANUPC("${query}"): ${found.length} row(s) — SKUs: [${found.map(p => p.sku).join(', ')}]`);
          return found;
        }
      } catch (err) {
        console.error('[BFF REST] findProductsByEANUPC failed:', err);
      }
    }

    return this.mockProducts.filter(p => (p.EANUPC || '').toLowerCase() === query.toLowerCase());
  }

  private async _findByEANInBarcodeTable(query: string): Promise<Product[]> {
    if (this.pgPool) {
      try {
        await this.ensureBarcodeTable();
        const res = await this.pgPool.query(
          `SELECT * FROM ${BARCODE_TABLE}
           WHERE LOWER(TRIM(COALESCE(ean_upc, '')))    = LOWER($1)
              OR LOWER(TRIM(COALESCE(custom_ean, ''))) = LOWER($1)`,
          [query]
        );
        const found = (res.rows || []).map((r: any) => this.rowToProductFromBarcodeTable(r));
        console.log(`[BFF Barcode PG] findProductsByEANUPC("${query}"): ${found.length} row(s) — SKUs: [${found.map(p => p.sku).join(', ')}]`);
        return found;
      } catch (err) {
        console.error('[BFF Barcode PG] findProductsByEANUPC failed:', err);
      }
    }

    if (this.supabaseClient) {
      try {
        const { data, error } = await this.supabaseClient
          .from(BARCODE_TABLE)
          .select('*')
          .or(`ean_upc.ilike.${query},custom_ean.ilike.${query}`);
        if (!error && data) {
          const found = data.map((r: any) => this.rowToProductFromBarcodeTable(r));
          console.log(`[BFF Barcode REST] findProductsByEANUPC("${query}"): ${found.length} row(s) — SKUs: [${found.map(p => p.sku).join(', ')}]`);
          return found;
        }
      } catch (err) {
        console.error('[BFF Barcode REST] findProductsByEANUPC failed:', err);
      }
    }

    return [];
  }

  // ── findDuplicates (public router) ───────────────────────────────────────
  // In barcode-table mode: uses the cross-field JOIN query (ean_upc = custom_ean,
  // different first-7 SKU prefix).  In central-DB mode: falls back to EAN equality.

  async findDuplicates(sku: string, ean: string): Promise<Product[]> {
    if (this.useBarcodeTable) {
      return this._findDuplicatesBySKU(sku);
    }
    return this.findProductsByEANUPC(ean);
  }

  private async _findDuplicatesBySKU(sku: string): Promise<Product[]> {
    // ── pgPool path ──
    if (this.pgPool) {
      try {
        await this.ensureBarcodeTable();
        // Mirror of the user-defined SQL:
        //   SELECT a.sku, b.sku FROM barcode_product_master a
        //   INNER JOIN barcode_product_master b ON a.ean_upc = b.custom_ean AND a.sku < b.sku
        //   WHERE LEFT(a.sku, 7) != LEFT(b.sku, 7)
        // Adapted to: given a SKU, return all product rows involved in a conflict pair.
        const res = await this.pgPool.query(
          `SELECT DISTINCT bpm.*
           FROM ${BARCODE_TABLE} bpm
           JOIN (
             SELECT a.sku AS s1, b.sku AS s2
             FROM ${BARCODE_TABLE} a
             INNER JOIN ${BARCODE_TABLE} b
               ON a.ean_upc = b.custom_ean
              AND a.sku    != b.sku
             WHERE LEFT(a.sku, 7) != LEFT(b.sku, 7)
               AND (a.sku = $1 OR b.sku = $1)
           ) pairs ON bpm.sku IN (pairs.s1, pairs.s2)`,
          [sku]
        );
        const found = (res.rows || []).map((r: any) => this.rowToProductFromBarcodeTable(r));
        console.log(`[BFF Barcode PG] findDuplicatesBySKU("${sku}"): ${found.length} row(s) — SKUs: [${found.map(p => p.sku).join(', ')}]`);
        return found;
      } catch (err) {
        console.error('[BFF Barcode PG] findDuplicatesBySKU failed:', err);
      }
    }

    // ── Supabase REST path ──
    // Decompose the JOIN into two sequential lookups since REST can't do self-joins.
    if (this.supabaseClient) {
      try {
        const { data: targetRow } = await this.supabaseClient
          .from(BARCODE_TABLE)
          .select('sku, ean_upc, custom_ean')
          .eq('sku', sku)
          .maybeSingle();

        if (!targetRow) return [];

        const prefix = sku.slice(0, 7);
        const conflictSkus = new Set<string>();

        // Case A: this SKU is the "a" side — its ean_upc equals another's custom_ean
        if (targetRow.ean_upc) {
          const { data } = await this.supabaseClient
            .from(BARCODE_TABLE)
            .select('sku')
            .eq('custom_ean', targetRow.ean_upc)
            .neq('sku', sku);
          for (const r of (data || [])) {
            if ((r.sku as string).slice(0, 7) !== prefix) conflictSkus.add(r.sku);
          }
        }

        // Case B: this SKU is the "b" side — its custom_ean equals another's ean_upc
        if (targetRow.custom_ean) {
          const { data } = await this.supabaseClient
            .from(BARCODE_TABLE)
            .select('sku')
            .eq('ean_upc', targetRow.custom_ean)
            .neq('sku', sku);
          for (const r of (data || [])) {
            if ((r.sku as string).slice(0, 7) !== prefix) conflictSkus.add(r.sku);
          }
        }

        if (conflictSkus.size === 0) return [];

        // Return both the current SKU and all conflicting SKUs as full product rows
        const allSkus = [sku, ...Array.from(conflictSkus)];
        const { data: allRows } = await this.supabaseClient
          .from(BARCODE_TABLE)
          .select('*')
          .in('sku', allSkus);

        const found = (allRows || []).map((r: any) => this.rowToProductFromBarcodeTable(r));
        console.log(`[BFF Barcode REST] findDuplicatesBySKU("${sku}"): ${found.length} row(s) — SKUs: [${found.map(p => p.sku).join(', ')}]`);
        return found;
      } catch (err) {
        console.error('[BFF Barcode REST] findDuplicatesBySKU failed:', err);
      }
    }

    return [];
  }

  // ── Settings (app_settings table) ────────────────────────────────────────

  private async ensureSettingsTable(): Promise<void> {
    if (!this.pgPool || this.initializedSettings) return;
    this.initializedSettings = true;
    const client = await this.pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key        TEXT PRIMARY KEY,
          value      JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `);
    } finally {
      client.release();
    }
  }

  async getSettings(): Promise<{ eanDuplicateEmails: string[] }> {
    const defaults = { eanDuplicateEmails: [] };

    if (this.pgPool) {
      try {
        await this.ensureSettingsTable();
        const res = await this.pgPool.query(
          `SELECT value FROM app_settings WHERE key = 'ean_duplicate_emails'`
        );
        if (res.rows.length > 0) return { eanDuplicateEmails: res.rows[0].value as string[] };
        return defaults;
      } catch (err) {
        console.error('[Settings] getSettings failed:', err);
        return defaults;
      }
    }

    if (this.supabaseClient) {
      try {
        const { data } = await this.supabaseClient
          .from('app_settings')
          .select('value')
          .eq('key', 'ean_duplicate_emails')
          .maybeSingle();
        if (data) return { eanDuplicateEmails: data.value as string[] };
        return defaults;
      } catch (err) {
        console.error('[Settings REST] getSettings failed:', err);
        return defaults;
      }
    }

    return defaults;
  }

  async saveSettings(settings: { eanDuplicateEmails: string[] }): Promise<void> {
    if (this.pgPool) {
      try {
        await this.ensureSettingsTable();
        await this.pgPool.query(
          `INSERT INTO app_settings (key, value, updated_at)
           VALUES ('ean_duplicate_emails', $1::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [JSON.stringify(settings.eanDuplicateEmails)]
        );
      } catch (err) {
        console.error('[Settings] saveSettings failed:', err);
      }
      return;
    }

    if (this.supabaseClient) {
      try {
        await this.supabaseClient
          .from('app_settings')
          .upsert(
            { key: 'ean_duplicate_emails', value: settings.eanDuplicateEmails, updated_at: new Date().toISOString() },
            { onConflict: 'key' }
          );
      } catch (err) {
        console.error('[Settings REST] saveSettings failed:', err);
      }
    }
  }

  // ── getAllProducts ────────────────────────────────────────────────────────

  async getAllProducts(): Promise<Product[]> {
    if (this.pgPool) {
      try {
        const table    = this.useBarcodeTable ? BARCODE_TABLE : CENTRAL_TABLE;
        const orderCol = this.useBarcodeTable ? 'item_name' : 'product_name';
        await (this.useBarcodeTable ? this.ensureBarcodeTable() : this.ensurePgTable());
        const res = await this.pgPool.query(
          `SELECT * FROM ${table} ORDER BY ${orderCol} ASC`
        );
        if (res.rows) {
          console.log(`[BFF Direct PG] [SUCCESS] Fetched all ${res.rows.length} products.`);
          return this.useBarcodeTable
            ? res.rows.map((r: any) => this.rowToProductFromBarcodeTable(r))
            : res.rows.map((r: any) => this.rowToProduct(r));
        }
      } catch (err) {
        console.error('[BFF Direct PG] Failed to fetch all products:', err);
      }
    }

    if (this.supabaseClient) {
      try {
        const tableName = this.useBarcodeTable ? BARCODE_TABLE : 'EasyEcomProductMaster';
        const orderCol  = this.useBarcodeTable ? 'item_name' : 'product_name';
        const { data, error } = await this.supabaseClient
          .from(tableName)
          .select('*')
          .order(orderCol, { ascending: true });

        if (error) {
          console.error('[BFF REST] Supabase REST query all products exception:', error);
        } else if (data) {
          console.log(`[BFF REST] [SUCCESS] Fetched all ${data.length} products.`);
          return this.useBarcodeTable
            ? data.map((r: any) => this.rowToProductFromBarcodeTable(r))
            : data.map((r: any) => this.rowToProduct(r));
        }
      } catch (err) {
        console.error('[BFF REST] Exception querying all products:', err);
      }
    }

    return this.mockProducts;
  }

  // ── syncBarcodeProductMaster ──────────────────────────────────────────────
  // Called by the /api/barcode/sync-barcode-master endpoint.
  // Accepts raw rows from the App Script response and upserts them into
  // barcode_product_master. Handles both original header names ("EAN/UPC")
  // and snake_case variants ("ean_upc") so the App Script can return either.

  async syncBarcodeProductMaster(rawRows: any[]): Promise<{ upserted: number; errors: number }> {
    if (!rawRows.length) return { upserted: 0, errors: 0 };
    await this.ensureBarcodeTable();

    const now     = new Date().toISOString();
    const pick    = (r: any, ...keys: string[]) => {
      for (const k of keys) {
        const v = r[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      return null;
    };

    const normalized = rawRows
      .map(r => ({
        sku:             pick(r, 'SKU', 'sku'),
        product_id:      pick(r, 'Product ID', 'product_id'),
        item_name:       pick(r, 'Item Name', 'item_name')    ?? '',
        product_type:    pick(r, 'Product Type', 'product_type'),
        brand:           pick(r, 'Brand', 'brand'),
        colour:          pick(r, 'Colour', 'colour'),
        brand_id:        pick(r, 'Brand Id', 'brand_id'),
        mrp:             pick(r, 'MRP', 'mrp')                ?? '',
        category_name:   pick(r, 'Category Name', 'category_name'),
        cost:            pick(r, 'Cost', 'cost'),
        mrp_in_ee:       pick(r, 'MRP in EE (changes for event POS)', 'mrp_in_ee'),
        model_no:        pick(r, 'Model No', 'model_no'),
        ean_upc:         pick(r, 'EAN/UPC', 'ean_upc'),
        article_number:  pick(r, 'Article Number', 'article_number'),
        custom_ean:      pick(r, 'Custom EAN', 'custom_ean'),
        barcode:         pick(r, 'Barcode', 'barcode'),
        sku_for_barcode: pick(r, 'SKU for Barcode', 'sku_for_barcode'),
        mom:             pick(r, 'MOM', 'mom'),
        batch_no:        pick(r, 'Batch No.', 'Batch No', 'batch_no'),
        inventory:       pick(r, 'Inventory', 'inventory'),
        updated_at:      pick(r, 'Updated At', 'updated_at') ? new Date(pick(r, 'Updated At', 'updated_at')!).toISOString() : null,
        synced_at:       now,
      }))
      .filter(r => r.sku);  // skip rows with no SKU

    let upserted = 0;
    let errors   = 0;

    if (this.pgPool) {
      const BATCH = 500;
      for (let i = 0; i < normalized.length; i += BATCH) {
        const chunk = normalized.slice(i, i + BATCH);
        const client = await this.pgPool.connect();
        try {
          await client.query('BEGIN');
          for (const row of chunk) {
            await client.query(
              `INSERT INTO ${BARCODE_TABLE}
                 (sku, product_id, item_name, product_type, brand, colour, brand_id,
                  mrp, category_name, cost, mrp_in_ee, model_no, ean_upc, article_number,
                  custom_ean, barcode, sku_for_barcode, mom, batch_no, inventory, updated_at, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
               ON CONFLICT (sku) DO UPDATE SET
                 product_id=EXCLUDED.product_id, item_name=EXCLUDED.item_name,
                 product_type=EXCLUDED.product_type, brand=EXCLUDED.brand,
                 colour=EXCLUDED.colour, brand_id=EXCLUDED.brand_id, mrp=EXCLUDED.mrp,
                 category_name=EXCLUDED.category_name, cost=EXCLUDED.cost,
                 mrp_in_ee=EXCLUDED.mrp_in_ee, model_no=EXCLUDED.model_no,
                 ean_upc=EXCLUDED.ean_upc, article_number=EXCLUDED.article_number,
                 custom_ean=EXCLUDED.custom_ean, barcode=EXCLUDED.barcode,
                 sku_for_barcode=EXCLUDED.sku_for_barcode, mom=EXCLUDED.mom,
                 batch_no=EXCLUDED.batch_no, inventory=EXCLUDED.inventory,
                 updated_at=EXCLUDED.updated_at, synced_at=EXCLUDED.synced_at`,
              [
                row.sku, row.product_id, row.item_name, row.product_type, row.brand,
                row.colour, row.brand_id, row.mrp, row.category_name, row.cost,
                row.mrp_in_ee, row.model_no, row.ean_upc, row.article_number,
                row.custom_ean, row.barcode, row.sku_for_barcode, row.mom,
                row.batch_no, row.inventory, row.updated_at, row.synced_at,
              ]
            );
            upserted++;
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[syncBarcodeProductMaster] Batch ${i}–${i + chunk.length} failed:`, err);
          errors += chunk.length;
          upserted -= chunk.length;
        } finally {
          client.release();
        }
      }
      return { upserted, errors };
    }

    if (this.supabaseClient) {
      const BATCH = 500;
      for (let i = 0; i < normalized.length; i += BATCH) {
        const chunk = normalized.slice(i, i + BATCH);
        try {
          const { error } = await this.supabaseClient
            .from(BARCODE_TABLE)
            .upsert(chunk, { onConflict: 'sku' });
          if (error) throw error;
          upserted += chunk.length;
        } catch (err) {
          console.error(`[syncBarcodeProductMaster] REST batch ${i} failed:`, err);
          errors += chunk.length;
        }
      }
      return { upserted, errors };
    }

    console.warn('[syncBarcodeProductMaster] No database connection — sync skipped.');
    return { upserted: 0, errors: normalized.length };
  }
}
