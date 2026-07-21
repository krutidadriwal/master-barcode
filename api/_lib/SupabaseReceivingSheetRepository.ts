import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';

export interface ReceivingSheetLine {
  line_id: string;
  po_id: string;
  po_ref_no: string | null;
  item_sku: string;
  ean_fnsku: string | null;
  item_name: string;
  qty: number;
  pending_qty: number;
  shipment_id: string | null;
  synced_at?: string;
}

const CHUNK = 200;

/**
 * Backs the "Download Receiving Sheet" feature. Data originates from the
 * 'Inventory' Google Sheet's "Purchase Orders" tab (a separate spreadsheet
 * from the one used by SupabaseVendorShipmentRepository) and is pulled in via
 * CodeScript/Inventory/ReceivingSheet_Sync.gs + ReceivingSheet_EntryPoints.gs.
 */
export class SupabaseReceivingSheetRepository {
  private pgPool: Pool | null = null;
  private supabaseClient: SupabaseClient | null = null;
  private initializedPg = false;

  constructor() {
    const dbUrl  = process.env.DATABASE_URL;
    const pgHost = process.env.PGHOST;
    const sbUrl  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const sbKey  = process.env.SUPABASE_SERVICE_KEY
                 || process.env.SUPABASE_ANON_KEY
                 || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (dbUrl || pgHost) {
      try {
        this.pgPool = new Pool(
          dbUrl
            ? { connectionString: dbUrl, ssl: dbUrl.includes('supabase.co') ? { rejectUnauthorized: false } : undefined }
            : {
                host:     pgHost,
                port:     parseInt(process.env.PGPORT || '5432'),
                database: process.env.PGDATABASE || 'postgres',
                user:     process.env.PGUSER || 'postgres',
                password: process.env.PGPASSWORD,
                ssl:      pgHost?.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
              }
        );
        console.log('[ReceivingSheet Repo] pgPool initialized.');
      } catch (err) {
        console.error('[ReceivingSheet Repo] Failed to init pgPool:', err);
      }
    }

    if (!this.pgPool && sbUrl && sbKey) {
      try {
        this.supabaseClient = createClient(sbUrl, sbKey);
        console.log('[ReceivingSheet Repo] Supabase REST client initialized.');
      } catch (err) {
        console.error('[ReceivingSheet Repo] Failed to init Supabase client:', err);
      }
    }
  }

  private async ensureTable(): Promise<void> {
    if (!this.pgPool || this.initializedPg) return;
    this.initializedPg = true;
    const client = await this.pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS inventory_po_lines (
          line_id     TEXT PRIMARY KEY,
          po_id       TEXT NOT NULL,
          po_ref_no   TEXT,
          item_sku    TEXT NOT NULL,
          ean_fnsku   TEXT,
          item_name   TEXT NOT NULL DEFAULT '',
          qty         INTEGER NOT NULL DEFAULT 0,
          pending_qty INTEGER NOT NULL DEFAULT 0,
          shipment_id TEXT,
          synced_at   TIMESTAMPTZ DEFAULT NOW()
        );

        ALTER TABLE inventory_po_lines ADD COLUMN IF NOT EXISTS shipment_id TEXT;

        CREATE INDEX IF NOT EXISTS idx_inventory_po_lines_po_id
          ON inventory_po_lines(po_id);
        CREATE INDEX IF NOT EXISTS idx_inventory_po_lines_shipment_id
          ON inventory_po_lines(shipment_id);
      `);
      console.log('[ReceivingSheet Repo] Table ensured.');
    } finally {
      client.release();
    }
  }

  // ── Sync (write from Apps Script data) ──────────────────────────────────────
  // Chunked multi-row upserts (not one awaited query per row) — this is called
  // as part of /api/shipment/sync, which runs under Vercel's 10s function
  // timeout. Sequential single-row round trips for 100+ lines blew past that
  // budget. Rows are deduped by line_id first since a multi-row INSERT ...
  // ON CONFLICT errors if the same key appears twice in one statement.

  async syncLines(rows: ReceivingSheetLine[]): Promise<number> {
    if (!rows.length) return 0;
    await this.ensureTable();

    const byLineId = new Map<string, ReceivingSheetLine>();
    for (const l of rows) byLineId.set(l.line_id, l);
    const deduped = Array.from(byLineId.values());

    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < deduped.length; i += CHUNK) {
          const chunk = deduped.slice(i, i + CHUNK);
          const placeholders = chunk.map((_, idx) => {
            const b = idx * 9;
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},NOW())`;
          }).join(',');
          const params = chunk.flatMap(l => [
            l.line_id, l.po_id, l.po_ref_no, l.item_sku, l.ean_fnsku, l.item_name, l.qty, l.pending_qty, l.shipment_id,
          ]);
          await client.query(
            `INSERT INTO inventory_po_lines
               (line_id, po_id, po_ref_no, item_sku, ean_fnsku, item_name, qty, pending_qty, shipment_id, synced_at)
             VALUES ${placeholders}
             ON CONFLICT (line_id) DO UPDATE SET
               po_id       = EXCLUDED.po_id,
               po_ref_no   = EXCLUDED.po_ref_no,
               item_sku    = EXCLUDED.item_sku,
               ean_fnsku   = EXCLUDED.ean_fnsku,
               item_name   = EXCLUDED.item_name,
               qty         = EXCLUDED.qty,
               pending_qty = EXCLUDED.pending_qty,
               shipment_id = EXCLUDED.shipment_id,
               synced_at   = NOW()`,
            params
          );
        }
        await client.query('COMMIT');
        return rows.length;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    if (this.supabaseClient) {
      const upsertRows = deduped.map(l => ({ ...l, synced_at: new Date().toISOString() }));
      const { error } = await this.supabaseClient
        .from('inventory_po_lines')
        .upsert(upsertRows, { onConflict: 'line_id', ignoreDuplicates: false });
      if (error) throw error;
      return rows.length;
    }

    return 0;
  }

  // ── Read (for the BFF API endpoints) ────────────────────────────────────────

  async getLines(): Promise<ReceivingSheetLine[]> {
    await this.ensureTable();

    if (this.pgPool) {
      const res = await this.pgPool.query<ReceivingSheetLine>(
        `SELECT * FROM inventory_po_lines ORDER BY po_id, item_sku`
      );
      return res.rows;
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from('inventory_po_lines').select('*').order('po_id');
      if (error) throw error;
      return data || [];
    }

    return [];
  }

  async getLinesForPO(poId: string): Promise<ReceivingSheetLine[]> {
    return this.getLinesByColumn_('po_id', poId);
  }

  async getLinesByPoId(poId: string): Promise<ReceivingSheetLine[]> {
    return this.getLinesByColumn_('po_id', poId);
  }

  async getLinesByShipmentId(shipmentId: string): Promise<ReceivingSheetLine[]> {
    return this.getLinesByColumn_('shipment_id', shipmentId);
  }

  async getLinesByPoRefNo(poRefNo: string): Promise<ReceivingSheetLine[]> {
    return this.getLinesByColumn_('po_ref_no', poRefNo);
  }

  private async getLinesByColumn_(column: 'po_id' | 'shipment_id' | 'po_ref_no', value: string): Promise<ReceivingSheetLine[]> {
    await this.ensureTable();

    if (this.pgPool) {
      const res = await this.pgPool.query<ReceivingSheetLine>(
        `SELECT * FROM inventory_po_lines WHERE ${column} = $1 ORDER BY po_id, item_sku`,
        [value]
      );
      return res.rows;
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from('inventory_po_lines').select('*').eq(column, value).order('po_id');
      if (error) throw error;
      return data || [];
    }

    return [];
  }
}
