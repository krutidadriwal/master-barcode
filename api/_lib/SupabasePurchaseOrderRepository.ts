import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';

export interface POHeader {
  id?: number;
  po_id: string;
  po_ref_num: string;
  total_po_value?: number;
  po_status_id?: string;
  po_created_date?: string;
  po_updated_date?: string;
  vendor_name?: string;
  vendor_code?: string;
  created_at?: string;
  updated_at?: string;
}

export interface POLine {
  id?: number;
  po_ref_num: string;
  po_id?: string;
  sku: string;
  original_quantity: number;
  pending_quantity: number;
  item_price?: number;
  created_at?: string;
  updated_at?: string;
}

export interface POSyncResult {
  headersInserted: number;
  headersUpdated: number;
  linesInserted: number;
  linesUpdated: number;
}

const CHUNK = 200;

export class SupabasePurchaseOrderRepository {
  private pgPool: Pool | null = null;
  private supabaseClient: SupabaseClient | null = null;
  private initializedPg = false;

  constructor() {
    const dbUrl = process.env.DATABASE_URL;
    const pgHost = process.env.PGHOST;
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

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
            ssl: (pgHost && pgHost.includes('supabase.co')) ? { rejectUnauthorized: false } : undefined,
          });
        }
      } catch (err) {
        console.error('[PO Repo] Failed to initialize pg pool:', err);
      }
    }

    if (supabaseUrl && supabaseKey && !this.pgPool) {
      try {
        this.supabaseClient = createClient(supabaseUrl, supabaseKey);
      } catch (err) {
        console.error('[PO Repo] Failed to initialize Supabase client:', err);
      }
    }
  }

  private async ensureTables(): Promise<void> {
    if (!this.pgPool || this.initializedPg) return;
    this.initializedPg = true;
    console.log('[PO Repo] ensureTables: creating tables if not exists...');
    const client = await this.pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS shipment_purchase_orders (
          id              SERIAL PRIMARY KEY,
          po_id           VARCHAR(200) UNIQUE NOT NULL,
          po_ref_num      VARCHAR(200) UNIQUE NOT NULL,
          total_po_value  NUMERIC(14,2),
          po_status_id    VARCHAR(100),
          po_created_date VARCHAR(100),
          po_updated_date VARCHAR(100),
          vendor_name     VARCHAR(300),
          vendor_code     VARCHAR(100),
          created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS shipment_purchase_order_lines (
          id                SERIAL PRIMARY KEY,
          po_ref_num        VARCHAR(200) NOT NULL,
          po_id             VARCHAR(200),
          sku               VARCHAR(200) NOT NULL,
          original_quantity INTEGER NOT NULL DEFAULT 0,
          pending_quantity  INTEGER NOT NULL DEFAULT 0,
          item_price        NUMERIC(14,2),
          created_at        TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at        TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT uq_spol_ref_sku UNIQUE (po_ref_num, sku)
        );

        CREATE INDEX IF NOT EXISTS idx_spo_po_ref_num  ON shipment_purchase_orders (po_ref_num);
        CREATE INDEX IF NOT EXISTS idx_spol_po_ref_num ON shipment_purchase_order_lines (po_ref_num);
        CREATE INDEX IF NOT EXISTS idx_spol_sku        ON shipment_purchase_order_lines (LOWER(sku));
      `);
      console.log('[PO Repo] ensureTables: done.');
    } catch (err) {
      console.error('[PO Repo] ensureTables FAILED:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertPOHeaders(headers: POHeader[]): Promise<{ inserted: number; updated: number }> {
    if (!headers.length) { console.log('[PO Repo] upsertPOHeaders: called with 0 headers, skipping.'); return { inserted: 0, updated: 0 }; }
    console.log(`[PO Repo] upsertPOHeaders: upserting ${headers.length} headers...`);
    await this.ensureTables();

    let inserted = 0;
    let updated = 0;

    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        const existingRes = await client.query(`SELECT po_ref_num FROM shipment_purchase_orders`);
        const existingRefs = new Set(existingRes.rows.map((r: any) => r.po_ref_num));

        for (const h of headers) {
          await client.query(`
            INSERT INTO shipment_purchase_orders
              (po_id, po_ref_num, total_po_value, po_status_id, po_created_date, po_updated_date, vendor_name, vendor_code, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
            ON CONFLICT (po_ref_num) DO UPDATE SET
              po_id           = EXCLUDED.po_id,
              total_po_value  = EXCLUDED.total_po_value,
              po_status_id    = EXCLUDED.po_status_id,
              po_created_date = EXCLUDED.po_created_date,
              po_updated_date = EXCLUDED.po_updated_date,
              vendor_name     = EXCLUDED.vendor_name,
              vendor_code     = EXCLUDED.vendor_code,
              updated_at      = CURRENT_TIMESTAMP
          `, [
            h.po_id, h.po_ref_num,
            h.total_po_value ?? null, h.po_status_id ?? null,
            h.po_created_date ?? null, h.po_updated_date ?? null,
            h.vendor_name ?? null, h.vendor_code ?? null,
          ]);
          if (existingRefs.has(h.po_ref_num)) updated++;
          else inserted++;
        }
        await client.query('COMMIT');
        console.log(`[PO Repo] upsertPOHeaders (pg): inserted=${inserted}, updated=${updated}`);
      } catch (err) {
        console.error('[PO Repo] upsertPOHeaders (pg) FAILED, rolling back:', err);
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return { inserted, updated };
    }

    if (this.supabaseClient) {
      for (const h of headers) {
        const { data: ex } = await this.supabaseClient
          .from('shipment_purchase_orders').select('po_ref_num').eq('po_ref_num', h.po_ref_num).maybeSingle();
        const { error: upsertErr } = await this.supabaseClient.from('shipment_purchase_orders').upsert({
          po_id: h.po_id, po_ref_num: h.po_ref_num,
          total_po_value: h.total_po_value ?? null, po_status_id: h.po_status_id ?? null,
          po_created_date: h.po_created_date ?? null, po_updated_date: h.po_updated_date ?? null,
          vendor_name: h.vendor_name ?? null, vendor_code: h.vendor_code ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'po_ref_num' });
        if (upsertErr) console.error('[PO Repo] upsertPOHeaders (supabase) row error:', upsertErr);
        if (ex) updated++; else inserted++;
      }
      console.log(`[PO Repo] upsertPOHeaders (supabase): inserted=${inserted}, updated=${updated}`);
    }

    return { inserted, updated };
  }

  async upsertPOLines(lines: POLine[]): Promise<{ inserted: number; updated: number }> {
    if (!lines.length) { console.log('[PO Repo] upsertPOLines: called with 0 lines, skipping.'); return { inserted: 0, updated: 0 }; }
    console.log(`[PO Repo] upsertPOLines: upserting ${lines.length} lines...`);
    await this.ensureTables();

    let inserted = 0;
    let updated = 0;

    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        const existingRes = await client.query(`SELECT po_ref_num, LOWER(sku) AS sku FROM shipment_purchase_order_lines`);
        const existingKeys = new Set(existingRes.rows.map((r: any) => `${r.po_ref_num}|${r.sku}`));

        for (let i = 0; i < lines.length; i += CHUNK) {
          const chunk = lines.slice(i, i + CHUNK);
          const placeholders = chunk.map((_, idx) => {
            const b = idx * 7;
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`;
          }).join(',');
          const params = chunk.flatMap(l => [
            l.po_ref_num, l.po_id ?? null, l.sku,
            l.original_quantity, l.pending_quantity,
            l.item_price ?? null, new Date().toISOString(),
          ]);

          await client.query(`
            INSERT INTO shipment_purchase_order_lines
              (po_ref_num, po_id, sku, original_quantity, pending_quantity, item_price, updated_at)
            VALUES ${placeholders}
            ON CONFLICT (po_ref_num, sku) DO UPDATE SET
              po_id             = EXCLUDED.po_id,
              original_quantity = EXCLUDED.original_quantity,
              pending_quantity  = EXCLUDED.pending_quantity,
              item_price        = EXCLUDED.item_price,
              updated_at        = EXCLUDED.updated_at
          `, params);

          for (const l of chunk) {
            if (existingKeys.has(`${l.po_ref_num}|${l.sku.toLowerCase()}`)) updated++;
            else inserted++;
          }
        }
        await client.query('COMMIT');
        console.log(`[PO Repo] upsertPOLines (pg): inserted=${inserted}, updated=${updated}`);
      } catch (err) {
        console.error('[PO Repo] upsertPOLines (pg) FAILED, rolling back:', err);
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return { inserted, updated };
    }

    if (this.supabaseClient) {
      for (const l of lines) {
        const { data: ex } = await this.supabaseClient
          .from('shipment_purchase_order_lines').select('id')
          .eq('po_ref_num', l.po_ref_num).eq('sku', l.sku).maybeSingle();
        const { error: lineErr } = await this.supabaseClient.from('shipment_purchase_order_lines').upsert({
          po_ref_num: l.po_ref_num, po_id: l.po_id ?? null, sku: l.sku,
          original_quantity: l.original_quantity, pending_quantity: l.pending_quantity,
          item_price: l.item_price ?? null, updated_at: new Date().toISOString(),
        }, { onConflict: 'po_ref_num,sku' });
        if (lineErr) console.error('[PO Repo] upsertPOLines (supabase) row error:', lineErr);
        if (ex) updated++; else inserted++;
      }
      console.log(`[PO Repo] upsertPOLines (supabase): inserted=${inserted}, updated=${updated}`);
    }

    return { inserted, updated };
  }

  async getPOLinesByRefNum(poRefNum: string): Promise<POLine[]> {
    await this.ensureTables();

    if (this.pgPool) {
      const res = await this.pgPool.query(
        `SELECT id, po_ref_num, po_id, sku, original_quantity, pending_quantity, item_price, created_at, updated_at
         FROM shipment_purchase_order_lines
         WHERE po_ref_num = $1
         ORDER BY sku ASC`,
        [poRefNum]
      );
      return res.rows.map(this.mapLine);
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from('shipment_purchase_order_lines')
        .select('id, po_ref_num, po_id, sku, original_quantity, pending_quantity, item_price, created_at, updated_at')
        .eq('po_ref_num', poRefNum)
        .order('sku', { ascending: true });
      if (error) throw error;
      return (data ?? []).map(this.mapLine);
    }

    return [];
  }

  async getDistinctPORefNums(): Promise<string[]> {
    await this.ensureTables();

    if (this.pgPool) {
      const res = await this.pgPool.query(
        `SELECT po_ref_num FROM shipment_purchase_orders ORDER BY po_ref_num ASC`
      );
      return res.rows.map((r: any) => r.po_ref_num);
    }

    if (this.supabaseClient) {
      const { data } = await this.supabaseClient
        .from('shipment_purchase_orders').select('po_ref_num').order('po_ref_num', { ascending: true });
      return (data ?? []).map((r: any) => r.po_ref_num);
    }

    return [];
  }

  private mapLine(r: any): POLine {
    return {
      id: r.id,
      po_ref_num: r.po_ref_num,
      po_id: r.po_id || undefined,
      sku: r.sku,
      original_quantity: r.original_quantity ?? 0,
      pending_quantity: r.pending_quantity ?? 0,
      item_price: r.item_price != null ? Number(r.item_price) : undefined,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
}
