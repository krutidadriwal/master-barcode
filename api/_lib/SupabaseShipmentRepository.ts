import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';

export interface ShipmentItem {
  product_id?: string;
  sku: string;
  planned_mode: 'AIR' | 'SEA';
  sku_name: string;
  cu_ordered_qty: number;
  fulfilled_qty?: number;
  session_qty?: number;
  created_at?: string;
  updated_at?: string;
}

export class SupabaseShipmentRepository {
  private supabaseClient: SupabaseClient | null = null;
  private pgPool: Pool | null = null;
  private initializedPg = false;

  private mockShipments: ShipmentItem[] = [];

  constructor() {
    const dbUrl = process.env.DATABASE_URL;
    const pgHost = process.env.PGHOST;

    if (dbUrl || pgHost) {
      try {
        console.log("[Shipment Repo] PostgreSQL direct database connection detected. Initializing pg Pool...");
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
        console.log("[Shipment Repo] PostgreSQL direct database connection pool created.");
      } catch (err) {
        console.error("[Shipment Repo] Failed to initialize PostgreSQL pool connection:", err);
      }
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (supabaseUrl && supabaseKey && !this.pgPool) {
      try {
        this.supabaseClient = createClient(supabaseUrl, supabaseKey);
        console.log("[Shipment Repo] Supabase REST API client successfully initialized.");
      } catch (err) {
        console.error("[Shipment Repo] Failed to construct Supabase REST client:", err);
      }
    }

    if (!this.pgPool && !this.supabaseClient) {
      console.log("[Shipment Repo] Running in local high-performance persistent in-memory sandbox mode.");
      this.seedMockShipments();
    }
  }

  private seedMockShipments() {
    this.mockShipments = [
      { sku: '1020137', planned_mode: 'AIR', sku_name: 'QiYi MP 2x2 M Stickerless',        cu_ordered_qty: 45, fulfilled_qty: 15, product_id: 'prod-seed-1' },
      { sku: '1020080', planned_mode: 'AIR', sku_name: 'QiYi QiDi S 2x2 Stickerless',      cu_ordered_qty: 25, fulfilled_qty: 5,  product_id: 'prod-seed-2' },
      { sku: '1030405', planned_mode: 'AIR', sku_name: 'MoYu MeiLong 3C 3x3 Stickerless',  cu_ordered_qty: 80, fulfilled_qty: 20, product_id: 'prod-seed-3' }
    ];
  }

  private async ensurePgTable(): Promise<void> {
    if (!this.pgPool || this.initializedPg) return;

    try {
      this.initializedPg = true;
      const client = await this.pgPool.connect();
      try {
        console.log("[Shipment Repo] Syncing schema: verifying 'shipment_barcode' table...");

        await client.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'shipment_barcode'
            ) AND NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'shipment_barcode'
                AND column_name = 'planned_mode'
            ) THEN
              DROP TABLE public.shipment_barcode;
            END IF;
          END $$;
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS shipment_barcode (
            sku           VARCHAR(100) NOT NULL,
            planned_mode  VARCHAR(10)  NOT NULL DEFAULT 'AIR',
            product_id    VARCHAR(100),
            sku_name      VARCHAR(255) NOT NULL,
            cu_ordered_qty INTEGER     NOT NULL DEFAULT 0,
            fulfilled_qty  INTEGER     NOT NULL DEFAULT 0,
            session_qty    INTEGER     NOT NULL DEFAULT 0,
            created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (sku, planned_mode)
          );
          ALTER TABLE shipment_barcode ADD COLUMN IF NOT EXISTS session_qty INTEGER NOT NULL DEFAULT 0;
        `);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[Shipment Repo] Failed to sync database schema:", err);
    }
  }

  async upsertShipmentItems(items: ShipmentItem[]): Promise<ShipmentItem[]> {
    const results: ShipmentItem[] = [];

    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const client = await this.pgPool.connect();
        try {
          await client.query('BEGIN');
          for (const item of items) {
            const res = await client.query(
              `INSERT INTO shipment_barcode (sku, planned_mode, product_id, sku_name, cu_ordered_qty, fulfilled_qty, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
               ON CONFLICT (sku, planned_mode)
               DO UPDATE SET
                 cu_ordered_qty = shipment_barcode.cu_ordered_qty + EXCLUDED.cu_ordered_qty,
                 fulfilled_qty  = shipment_barcode.fulfilled_qty  + EXCLUDED.fulfilled_qty,
                 sku_name       = EXCLUDED.sku_name,
                 product_id     = COALESCE(EXCLUDED.product_id, shipment_barcode.product_id),
                 updated_at     = CURRENT_TIMESTAMP
               RETURNING *;`,
              [item.sku.trim(), item.planned_mode, item.product_id || null, item.sku_name.trim(), item.cu_ordered_qty, item.fulfilled_qty || 0]
            );
            if (res.rows && res.rows[0]) results.push(this.mapRow(res.rows[0]));
          }
          await client.query('COMMIT');
          return results;
        } catch (err) {
          await client.query('ROLLBACK');
          console.error("[Shipment Repo] PG transaction error during upsert:", err);
        } finally {
          client.release();
        }
      } catch (err) {
        console.error("[Shipment Repo] PG connection exception inside upsert:", err);
      }
    }

    if (this.supabaseClient) {
      try {
        for (const item of items) {
          const { data: existing } = await this.supabaseClient
            .from('shipment_barcode')
            .select('*')
            .eq('sku', item.sku.trim())
            .eq('planned_mode', item.planned_mode)
            .maybeSingle();

          let targetQty       = item.cu_ordered_qty;
          let targetFulfilled = item.fulfilled_qty || 0;
          if (existing) {
            targetQty       = (existing.cu_ordered_qty || 0) + item.cu_ordered_qty;
            targetFulfilled = (existing.fulfilled_qty  || 0) + (item.fulfilled_qty || 0);
          }

          const { data, error } = await this.supabaseClient
            .from('shipment_barcode')
            .upsert({
              sku: item.sku.trim(), planned_mode: item.planned_mode,
              product_id: item.product_id || null, sku_name: item.sku_name.trim(),
              cu_ordered_qty: targetQty, fulfilled_qty: targetFulfilled,
              updated_at: new Date().toISOString()
            }, { onConflict: 'sku,planned_mode' })
            .select().single();

          if (error) console.error("[Shipment Repo] Supabase REST upsert failed:", error);
          else if (data) results.push(this.mapRow(data));
        }
        return results;
      } catch (err) {
        console.error("[Shipment Repo] Supabase REST exceptionally crashed during upsert:", err);
      }
    }

    for (const item of items) {
      const existingIdx = this.mockShipments.findIndex(
        s => s.sku.trim() === item.sku.trim() && s.planned_mode === item.planned_mode
      );
      if (existingIdx !== -1) {
        this.mockShipments[existingIdx].cu_ordered_qty += item.cu_ordered_qty;
        this.mockShipments[existingIdx].fulfilled_qty   = (this.mockShipments[existingIdx].fulfilled_qty || 0) + (item.fulfilled_qty || 0);
        this.mockShipments[existingIdx].sku_name        = item.sku_name.trim();
        if (item.product_id) this.mockShipments[existingIdx].product_id = item.product_id;
        this.mockShipments[existingIdx].updated_at = new Date().toISOString();
        results.push(this.mockShipments[existingIdx]);
      } else {
        const newItem: ShipmentItem = {
          sku: item.sku.trim(), planned_mode: item.planned_mode,
          product_id: item.product_id, sku_name: item.sku_name.trim(),
          cu_ordered_qty: item.cu_ordered_qty, fulfilled_qty: item.fulfilled_qty || 0,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        };
        this.mockShipments.push(newItem);
        results.push(newItem);
      }
    }
    return results;
  }

  async getAllShipments(mode: 'AIR' | 'SEA'): Promise<ShipmentItem[]> {
    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const res = await this.pgPool.query(
          `SELECT sku, planned_mode, product_id, sku_name, cu_ordered_qty, fulfilled_qty, session_qty, created_at, updated_at
           FROM shipment_barcode WHERE planned_mode = $1 ORDER BY sku_name ASC`,
          [mode]
        );
        if (res.rows) return res.rows.map(row => this.mapRow(row));
      } catch (err) {
        console.error("[Shipment Repo] PG error fetching shipments:", err);
      }
    }

    if (this.supabaseClient) {
      try {
        const { data, error } = await this.supabaseClient
          .from('shipment_barcode')
          .select('sku, planned_mode, product_id, sku_name, cu_ordered_qty, fulfilled_qty, session_qty, created_at, updated_at')
          .eq('planned_mode', mode)
          .order('sku_name', { ascending: true });

        if (error) console.error("[Shipment Repo] Supabase REST error fetching shipments:", error);
        else if (data) return (data as any[]).map(row => this.mapRow(row));
      } catch (err) {
        console.error("[Shipment Repo] Exception fetching shipments via REST client:", err);
      }
    }

    return this.mockShipments.filter(s => s.planned_mode === mode);
  }

  async incrementFulfilledQty(
    sku: string, skuName: string, productId: string | null,
    incrementBy: number, plannedMode: 'AIR' | 'SEA'
  ): Promise<void> {
    sku     = sku.trim();
    skuName = skuName.trim();

    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        const client = await this.pgPool.connect();
        try {
          await client.query(
            `INSERT INTO shipment_barcode (sku, planned_mode, product_id, sku_name, cu_ordered_qty, fulfilled_qty, updated_at)
             VALUES ($1, $2, $3, $4, 0, $5, CURRENT_TIMESTAMP)
             ON CONFLICT (sku, planned_mode)
             DO UPDATE SET fulfilled_qty = shipment_barcode.fulfilled_qty + EXCLUDED.fulfilled_qty, updated_at = CURRENT_TIMESTAMP;`,
            [sku, plannedMode, productId || null, skuName, incrementBy]
          );
        } finally {
          client.release();
        }
      } catch (err) {
        console.error("[Shipment Repo] PG error in incrementFulfilledQty:", err);
        throw err;
      }
      return;
    }

    if (this.supabaseClient) {
      try {
        const { data: existing } = await this.supabaseClient
          .from('shipment_barcode').select('*')
          .eq('sku', sku).eq('planned_mode', plannedMode).maybeSingle();

        if (existing) {
          await this.supabaseClient.from('shipment_barcode')
            .update({ fulfilled_qty: (existing.fulfilled_qty || 0) + incrementBy, updated_at: new Date().toISOString() })
            .eq('sku', sku).eq('planned_mode', plannedMode);
        } else {
          await this.supabaseClient.from('shipment_barcode')
            .insert({ sku, planned_mode: plannedMode, product_id: productId || null, sku_name: skuName, cu_ordered_qty: 0, fulfilled_qty: incrementBy, updated_at: new Date().toISOString() });
        }
      } catch (err) {
        console.error("[Shipment Repo] Supabase REST error in incrementFulfilledQty:", err);
        throw err;
      }
      return;
    }

    const existingIdx = this.mockShipments.findIndex(
      s => s.sku.trim().toLowerCase() === sku.toLowerCase() && s.planned_mode === plannedMode
    );
    if (existingIdx !== -1) {
      this.mockShipments[existingIdx].fulfilled_qty = (this.mockShipments[existingIdx].fulfilled_qty || 0) + incrementBy;
      this.mockShipments[existingIdx].updated_at    = new Date().toISOString();
    } else {
      this.mockShipments.push({
        sku, planned_mode: plannedMode, product_id: productId || undefined,
        sku_name: skuName, cu_ordered_qty: 0, fulfilled_qty: incrementBy,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
    }
  }

  /** Increments session_qty by 1 for the scanned SKU in real-time (called on every valid scan). */
  async incrementSessionQty(
    sku: string, skuName: string, productId: string | null, mode: 'AIR' | 'SEA'
  ): Promise<void> {
    sku = sku.trim();

    if (this.pgPool) {
      await this.ensurePgTable();
      await this.pgPool.query(
        `INSERT INTO shipment_barcode (sku, planned_mode, product_id, sku_name, cu_ordered_qty, fulfilled_qty, session_qty, updated_at)
         VALUES ($1, $2, $3, $4, 0, 0, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (sku, planned_mode)
         DO UPDATE SET session_qty = shipment_barcode.session_qty + 1, updated_at = CURRENT_TIMESTAMP;`,
        [sku, mode, productId || null, skuName.trim()]
      );
      return;
    }

    if (this.supabaseClient) {
      const { data: existing } = await this.supabaseClient
        .from('shipment_barcode').select('session_qty')
        .eq('sku', sku).eq('planned_mode', mode).maybeSingle();
      if (existing) {
        await this.supabaseClient.from('shipment_barcode')
          .update({ session_qty: (existing.session_qty || 0) + 1, updated_at: new Date().toISOString() })
          .eq('sku', sku).eq('planned_mode', mode);
      } else {
        await this.supabaseClient.from('shipment_barcode')
          .insert({ sku, planned_mode: mode, product_id: productId || null, sku_name: skuName.trim(), cu_ordered_qty: 0, fulfilled_qty: 0, session_qty: 1, updated_at: new Date().toISOString() });
      }
      return;
    }

    const idx = this.mockShipments.findIndex(s => s.sku.toLowerCase() === sku.toLowerCase() && s.planned_mode === mode);
    if (idx !== -1) {
      this.mockShipments[idx].session_qty = (this.mockShipments[idx].session_qty || 0) + 1;
    } else {
      this.mockShipments.push({ sku, planned_mode: mode, product_id: productId || undefined, sku_name: skuName, cu_ordered_qty: 0, fulfilled_qty: 0, session_qty: 1 });
    }
  }

  /** Moves session_qty into fulfilled_qty and resets session_qty = 0 (called at Confirm Session). */
  async commitSession(mode: 'AIR' | 'SEA'): Promise<void> {
    if (this.pgPool) {
      await this.ensurePgTable();
      await this.pgPool.query(
        `UPDATE shipment_barcode
         SET fulfilled_qty = fulfilled_qty + session_qty, session_qty = 0, updated_at = CURRENT_TIMESTAMP
         WHERE planned_mode = $1 AND session_qty > 0;`,
        [mode]
      );
      return;
    }

    if (this.supabaseClient) {
      const { data: rows } = await this.supabaseClient
        .from('shipment_barcode').select('sku, fulfilled_qty, session_qty')
        .eq('planned_mode', mode).gt('session_qty', 0);
      for (const row of rows ?? []) {
        await this.supabaseClient.from('shipment_barcode')
          .update({ fulfilled_qty: (row.fulfilled_qty || 0) + (row.session_qty || 0), session_qty: 0, updated_at: new Date().toISOString() })
          .eq('sku', row.sku).eq('planned_mode', mode);
      }
      return;
    }

    for (const s of this.mockShipments.filter(s => s.planned_mode === mode)) {
      s.fulfilled_qty = (s.fulfilled_qty || 0) + (s.session_qty || 0);
      s.session_qty = 0;
    }
  }

  /** Resets session_qty = 0 for all rows in the mode (called at Discard Session). */
  async discardSession(mode: 'AIR' | 'SEA'): Promise<void> {
    if (this.pgPool) {
      await this.ensurePgTable();
      await this.pgPool.query(
        `UPDATE shipment_barcode SET session_qty = 0, updated_at = CURRENT_TIMESTAMP WHERE planned_mode = $1;`,
        [mode]
      );
      return;
    }

    if (this.supabaseClient) {
      await this.supabaseClient.from('shipment_barcode')
        .update({ session_qty: 0, updated_at: new Date().toISOString() })
        .eq('planned_mode', mode);
      return;
    }

    for (const s of this.mockShipments.filter(s => s.planned_mode === mode)) {
      s.session_qty = 0;
    }
  }

  async resetShipments(mode: 'AIR' | 'SEA'): Promise<void> {
    if (this.pgPool) {
      try {
        await this.ensurePgTable();
        await this.pgPool.query(`DELETE FROM shipment_barcode WHERE planned_mode = $1;`, [mode]);
      } catch (err) {
        console.error("[Shipment Repo] Failed to delete rows via PG:", err);
      }
    }

    if (this.supabaseClient) {
      try {
        await this.supabaseClient.from('shipment_barcode').delete().eq('planned_mode', mode);
      } catch (err) {
        console.error("[Shipment Repo] Failed to clear Supabase collection:", err);
      }
    }

    this.mockShipments = this.mockShipments.filter(s => s.planned_mode !== mode);
  }

  private mapRow(row: any): ShipmentItem {
    return {
      sku: row.sku, planned_mode: row.planned_mode as 'AIR' | 'SEA',
      product_id: row.product_id || undefined, sku_name: row.sku_name,
      cu_ordered_qty: row.cu_ordered_qty, fulfilled_qty: row.fulfilled_qty || 0,
      session_qty: row.session_qty || 0,
      created_at: row.created_at, updated_at: row.updated_at
    };
  }
}
