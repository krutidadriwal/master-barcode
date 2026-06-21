export interface Product {
  product_id: string;
  sku: string;
  item_name: string;
  mrp: string;
  ean_upc: string;
  custom_ean?: string;
  batch_no?: string;
}

export interface ProductionOrderRow {
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
  created_at?: string;
  updated_at?: string;
}

export interface SyncResult {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}
