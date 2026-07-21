import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';

export interface VendorBatch {
  batch_id: string;
  status: string | null;
  expected_delivery: string | null;
  actual_delivery: string | null;
  carrier: string | null;
  remarks: string | null;
  synced_at?: string;
}

export interface VendorShipment {
  shipment_id: string;
  batch_id: string;
  vendor_code: string | null;
  invoice_no: string | null;
  invoice_date: string | null;
  carton_count: number;
  total_units: number;
  synced_at?: string;
  // Supabase-only fields — set from the app's weight-confirmation step, never
  // sent to or read from Apps Script. Deliberately excluded from syncShipments()
  // so a re-sync from the sheet can never touch or clear them.
  listed_weight?: number | null;
  actual_weight?: number | null;
  drive_link?: string | null;
}

export interface VendorShipmentLine {
  line_id: string;
  shipment_id: string;
  batch_id: string;
  vendor_code: string | null;
  sku: string;
  item_name: string;
  ean: string | null;
  incoming_qty: number;
  scanned_quantity: number;
  synced_at?: string;
  updated_at?: string;
}

const CHUNK = 200;

// A multi-row INSERT ... ON CONFLICT DO UPDATE errors ("cannot affect row a
// second time") if the same conflict key appears twice in one statement.
// The sheet feed can legitimately repeat a key across rows (e.g. a corrected
// line further down) — keep only the last occurrence, matching the previous
// sequential per-row upsert's last-write-wins behavior.
function dedupeByKey<T>(rows: T[], keyFn: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(keyFn(row), row);
  return Array.from(byKey.values());
}

export class SupabaseVendorShipmentRepository {
  private pgPool: Pool | null = null;
  private supabaseClient: SupabaseClient | null = null;
  private initializedPg = false;

  constructor() {
    const dbUrl   = process.env.DATABASE_URL;
    const pgHost  = process.env.PGHOST;
    const sbUrl   = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    // Prefer service role key for server-side mutations (bypasses RLS)
    const sbKey   = process.env.SUPABASE_SERVICE_KEY
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
        console.log('[VendorShipment Repo] pgPool initialized.');
      } catch (err) {
        console.error('[VendorShipment Repo] Failed to init pgPool:', err);
      }
    }

    if (!this.pgPool && sbUrl && sbKey) {
      try {
        this.supabaseClient = createClient(sbUrl, sbKey);
        console.log('[VendorShipment Repo] Supabase REST client initialized.');
      } catch (err) {
        console.error('[VendorShipment Repo] Failed to init Supabase client:', err);
      }
    }
  }

  private async dropLegacyConstraints(): Promise<void> {
    if (!this.pgPool) return;
    const client = await this.pgPool.connect();
    try {
      for (const stmt of [
        `ALTER TABLE IF EXISTS vendor_shipment_lines DROP CONSTRAINT IF EXISTS vendor_shipment_lines_shipment_id_fkey`,
        `ALTER TABLE IF EXISTS vendor_shipments DROP CONSTRAINT IF EXISTS vendor_shipments_batch_id_fkey`,
      ]) {
        try { await client.query(stmt); }
        catch (e: any) { console.warn('[VendorShipment Repo] Drop FK warning:', e.message); }
      }
    } finally {
      client.release();
    }
  }

  private async ensureTables(): Promise<void> {
    if (!this.pgPool || this.initializedPg) return;
    this.initializedPg = true;
    const client = await this.pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS vendor_shipment_batches (
          batch_id          TEXT PRIMARY KEY,
          status            TEXT,
          expected_delivery TEXT,
          actual_delivery   TEXT,
          carrier           TEXT,
          remarks           TEXT,
          synced_at         TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS vendor_shipments (
          shipment_id  TEXT PRIMARY KEY,
          batch_id     TEXT,
          vendor_code  TEXT,
          invoice_no   TEXT,
          invoice_date TEXT,
          carton_count INTEGER NOT NULL DEFAULT 0,
          total_units  INTEGER NOT NULL DEFAULT 0,
          synced_at    TIMESTAMPTZ DEFAULT NOW(),
          listed_weight REAL,
          actual_weight REAL,
          drive_link    TEXT
        );

        ALTER TABLE vendor_shipments ADD COLUMN IF NOT EXISTS listed_weight REAL;
        ALTER TABLE vendor_shipments ADD COLUMN IF NOT EXISTS actual_weight REAL;
        ALTER TABLE vendor_shipments ADD COLUMN IF NOT EXISTS drive_link    TEXT;

        CREATE TABLE IF NOT EXISTS vendor_shipment_lines (
          line_id          TEXT PRIMARY KEY,
          shipment_id      TEXT,
          batch_id         TEXT,
          vendor_code      TEXT,
          sku              TEXT NOT NULL,
          item_name        TEXT NOT NULL DEFAULT '',
          ean              TEXT,
          incoming_qty     INTEGER NOT NULL DEFAULT 0,
          scanned_quantity INTEGER NOT NULL DEFAULT 0,
          synced_at        TIMESTAMPTZ DEFAULT NOW(),
          updated_at       TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_vendor_shipment_lines_shipment
          ON vendor_shipment_lines(shipment_id);
        CREATE INDEX IF NOT EXISTS idx_vendor_shipment_lines_batch
          ON vendor_shipment_lines(batch_id);
      `);
      console.log('[VendorShipment Repo] Tables ensured.');
    } finally {
      client.release();
    }
  }

  // ── Sync (write from Apps Script data) ──────────────────────────────────────
  // Chunked multi-row upserts (not one awaited query per row) — this endpoint
  // runs under Vercel's 10s function timeout (vercel.json), and a shipment
  // sync can carry 600+ lines. Sequential single-row round trips blew past
  // that budget, silently truncating the sync before vendor_shipments/lines
  // finished writing. Mirrors the batching pattern in SupabasePurchaseOrderRepository.

  async syncBatches(rows: VendorBatch[]): Promise<number> {
    await this.dropLegacyConstraints();
    if (!rows.length) return 0;
    await this.ensureTables();
    rows = dedupeByKey(rows, b => b.batch_id);

    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const placeholders = chunk.map((_, idx) => {
            const b = idx * 6;
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},NOW())`;
          }).join(',');
          const params = chunk.flatMap(b => [
            b.batch_id, b.status, b.expected_delivery, b.actual_delivery, b.carrier, b.remarks,
          ]);
          await client.query(
            `INSERT INTO vendor_shipment_batches
               (batch_id, status, expected_delivery, actual_delivery, carrier, remarks, synced_at)
             VALUES ${placeholders}
             ON CONFLICT (batch_id) DO UPDATE SET
               status = EXCLUDED.status,
               expected_delivery = EXCLUDED.expected_delivery,
               actual_delivery   = EXCLUDED.actual_delivery,
               carrier           = EXCLUDED.carrier,
               remarks           = EXCLUDED.remarks,
               synced_at         = NOW()`,
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
      const { error } = await this.supabaseClient
        .from('vendor_shipment_batches')
        .upsert(rows.map(b => ({ ...b, synced_at: new Date().toISOString() })), { onConflict: 'batch_id' });
      if (error) throw error;
      return rows.length;
    }

    return 0;
  }

  async syncShipments(rows: VendorShipment[]): Promise<number> {
    if (!rows.length) return 0;
    await this.ensureTables();
    rows = dedupeByKey(rows, s => s.shipment_id);

    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const placeholders = chunk.map((_, idx) => {
            const b = idx * 7;
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},NOW())`;
          }).join(',');
          const params = chunk.flatMap(s => [
            s.shipment_id, s.batch_id, s.vendor_code, s.invoice_no, s.invoice_date, s.carton_count, s.total_units,
          ]);
          await client.query(
            `INSERT INTO vendor_shipments
               (shipment_id, batch_id, vendor_code, invoice_no, invoice_date, carton_count, total_units, synced_at)
             VALUES ${placeholders}
             ON CONFLICT (shipment_id) DO UPDATE SET
               batch_id     = EXCLUDED.batch_id,
               vendor_code  = EXCLUDED.vendor_code,
               invoice_no   = EXCLUDED.invoice_no,
               invoice_date = EXCLUDED.invoice_date,
               carton_count = EXCLUDED.carton_count,
               total_units  = EXCLUDED.total_units,
               synced_at    = NOW()`,
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
      const { error } = await this.supabaseClient
        .from('vendor_shipments')
        .upsert(rows.map(s => ({ ...s, synced_at: new Date().toISOString() })), { onConflict: 'shipment_id' });
      if (error) throw error;
      return rows.length;
    }

    return 0;
  }

  async syncLines(rows: VendorShipmentLine[]): Promise<number> {
    if (!rows.length) return 0;
    await this.ensureTables();
    rows = dedupeByKey(rows, l => l.line_id);

    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const placeholders = chunk.map((_, idx) => {
            const b = idx * 8;
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},NOW(),NOW())`;
          }).join(',');
          // scanned_quantity is intentionally NOT overwritten on re-sync
          const params = chunk.flatMap(l => [
            l.line_id, l.shipment_id, l.batch_id, l.vendor_code, l.sku, l.item_name, l.ean, l.incoming_qty,
          ]);
          await client.query(
            `INSERT INTO vendor_shipment_lines
               (line_id, shipment_id, batch_id, vendor_code, sku, item_name, ean, incoming_qty, synced_at, updated_at)
             VALUES ${placeholders}
             ON CONFLICT (line_id) DO UPDATE SET
               shipment_id  = EXCLUDED.shipment_id,
               batch_id     = EXCLUDED.batch_id,
               vendor_code  = EXCLUDED.vendor_code,
               item_name    = EXCLUDED.item_name,
               ean          = EXCLUDED.ean,
               incoming_qty = EXCLUDED.incoming_qty,
               synced_at    = NOW()`,
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
      const upsertRows = rows.map(l => ({
        line_id: l.line_id, shipment_id: l.shipment_id, batch_id: l.batch_id,
        vendor_code: l.vendor_code, sku: l.sku, item_name: l.item_name,
        ean: l.ean, incoming_qty: l.incoming_qty,
        synced_at: new Date().toISOString(),
      }));
      const { error } = await this.supabaseClient
        .from('vendor_shipment_lines')
        .upsert(upsertRows, { onConflict: 'line_id', ignoreDuplicates: false });
      if (error) throw error;
      return rows.length;
    }

    return 0;
  }

  // ── Scan write-back ──────────────────────────────────────────────────────────

  async incrementScannedQty(lineId: string): Promise<void> {
    await this.ensureTables();

    if (this.pgPool) {
      await this.pgPool.query(
        `UPDATE vendor_shipment_lines
         SET scanned_quantity = scanned_quantity + 1, updated_at = NOW()
         WHERE line_id = $1`,
        [lineId]
      );
      return;
    }

    if (this.supabaseClient) {
      // Use rpc for an atomic increment; falls back to read-modify-write if rpc unavailable
      const { error: rpcErr } = await this.supabaseClient.rpc('increment_scanned_qty', { p_line_id: lineId });
      if (rpcErr) {
        // rpc function not deployed — fall back to read-modify-write
        const { data: row, error: selErr } = await this.supabaseClient
          .from('vendor_shipment_lines').select('scanned_quantity').eq('line_id', lineId).single();
        if (selErr) throw new Error(`scan-line select failed: ${selErr.message}`);
        const { error: updErr } = await this.supabaseClient
          .from('vendor_shipment_lines')
          .update({ scanned_quantity: (row?.scanned_quantity || 0) + 1, updated_at: new Date().toISOString() })
          .eq('line_id', lineId);
        if (updErr) throw new Error(`scan-line update failed: ${updErr.message}`);
      }
    }
  }

  // ── Read (for the BFF API endpoints) ────────────────────────────────────────

  async getBatches(): Promise<VendorBatch[]> {
    await this.ensureTables();

    if (this.pgPool) {
      const res = await this.pgPool.query<VendorBatch>(`SELECT * FROM vendor_shipment_batches ORDER BY batch_id`);
      return res.rows;
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from('vendor_shipment_batches').select('*').order('batch_id');
      if (error) throw error;
      return data || [];
    }

    return [];
  }

  async getShipmentByShipmentId(shipmentId: string): Promise<VendorShipment | null> {
    await this.ensureTables();

    if (this.pgPool) {
      const res = await this.pgPool.query<VendorShipment>(
        `SELECT * FROM vendor_shipments WHERE shipment_id = $1 LIMIT 1`,
        [shipmentId]
      );
      return res.rows[0] || null;
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from('vendor_shipments').select('*').eq('shipment_id', shipmentId).limit(1).maybeSingle();
      if (error) throw error;
      return data || null;
    }

    return null;
  }

  // ── Weight confirmation (Supabase-only; never touched by syncShipments/Apps Script) ──

  async updateShipmentWeights(shipmentId: string, listedWeight: number, actualWeight: number): Promise<void> {
    await this.ensureTables();

    if (this.pgPool) {
      await this.pgPool.query(
        `UPDATE vendor_shipments SET listed_weight = $1, actual_weight = $2 WHERE shipment_id = $3`,
        [listedWeight, actualWeight, shipmentId]
      );
      return;
    }

    if (this.supabaseClient) {
      const { error } = await this.supabaseClient
        .from('vendor_shipments')
        .update({ listed_weight: listedWeight, actual_weight: actualWeight })
        .eq('shipment_id', shipmentId);
      if (error) throw error;
    }
  }

  async updateShipmentDriveLink(shipmentId: string, driveLink: string): Promise<void> {
    await this.ensureTables();

    if (this.pgPool) {
      await this.pgPool.query(
        `UPDATE vendor_shipments SET drive_link = $1 WHERE shipment_id = $2`,
        [driveLink, shipmentId]
      );
      return;
    }

    if (this.supabaseClient) {
      const { error } = await this.supabaseClient
        .from('vendor_shipments')
        .update({ drive_link: driveLink })
        .eq('shipment_id', shipmentId);
      if (error) throw error;
    }
  }

  async getShipmentsForBatch(batchId: string): Promise<VendorShipment[]> {
    await this.ensureTables();

    if (this.pgPool) {
      const res = await this.pgPool.query<VendorShipment>(
        `SELECT * FROM vendor_shipments WHERE batch_id = $1 ORDER BY shipment_id`,
        [batchId]
      );
      return res.rows;
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from('vendor_shipments').select('*').eq('batch_id', batchId).order('shipment_id');
      if (error) throw error;
      return data || [];
    }

    return [];
  }

  async getLinesForBatch(batchId: string): Promise<VendorShipmentLine[]> {
    await this.ensureTables();

    if (this.pgPool) {
      const res = await this.pgPool.query<VendorShipmentLine>(
        `SELECT * FROM vendor_shipment_lines WHERE batch_id = $1 ORDER BY shipment_id, sku`,
        [batchId]
      );
      return res.rows;
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from('vendor_shipment_lines').select('*').eq('batch_id', batchId).order('shipment_id');
      if (error) throw error;
      return data || [];
    }

    return [];
  }

  // ── Writeback payload (for hourly sync to Apps Script) ──────────────────────

  async getScannedQuantitiesForWriteback(): Promise<Array<{ shipment_id: string; sku: string; scanned_quantity: number }>> {
    await this.ensureTables();

    if (this.pgPool) {
      const res = await this.pgPool.query(
        `SELECT shipment_id, sku, scanned_quantity FROM vendor_shipment_lines WHERE scanned_quantity > 0`
      );
      return res.rows;
    }

    if (this.supabaseClient) {
      const { data, error } = await this.supabaseClient
        .from('vendor_shipment_lines')
        .select('shipment_id, sku, scanned_quantity')
        .gt('scanned_quantity', 0);
      if (error) throw error;
      return data || [];
    }

    return [];
  }
}
