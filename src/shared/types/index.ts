import { ReactNode } from 'react';

export interface AppModule {
  id: string;
  name: string;
  icon: ReactNode;
  component: ReactNode;
}

export interface Product {
  product_id: string;
  sku: string;
  item_name: string;
  mrp: string; // e.g. "499" or "Rs. 499/-"
  ean_upc: string;
  custom_ean?: string;
  batch_no?: string;
}

export interface BarcodeCache {
  identifier: string;
  product: Product;
  quantity: number;
}

export interface ProductionOrderRow {
  id: number;
  reference_code_original: string;
  reference_code_short: string;
  import_date: string;
  order_quantity: number;
  item_status: string;
  item_quantity: number;
  shipped_quantity: number;
  cancelled_quantity: number;
  sku: string;
  product_name: string;
  brand: string;
  model_no: string;
  ean: string;
  size: string;
  code_match?: boolean | null;
}
