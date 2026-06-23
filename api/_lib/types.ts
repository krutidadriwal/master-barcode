export interface Product {
  id?: string;
  product_id: string;
  sku: string;
  product_name: string;
  brand?: string;
  brand_id?: string;
  mrp: string;
  model_no?: string;
  EANUPC?: string;
  accounting_sku?: string;
  product_image_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProductMasterSyncResult {
  inserted: number;
  updated: number;
  deleted: number;
  total: number;
}

export interface ProductionOrderRow {
  id?: number;
  reference_code_original: string;
  reference_code_short: string;
  import_date: string;
  order_quantity: number;
  item_status: string;
  suborder_quantity: number;
  item_quantity: number;
  returned_quantity: number;
  cancelled_quantity: number;
  shipped_quantity: number;
  sku: string;
  sub_product_count: number;
  product_name: string;
  brand: string;
  model_no: string;
  ean: string;
  size: string;
  code_match?: boolean | null;
  created_at?: string;
  updated_at?: string;
}

export interface SyncResult {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}
