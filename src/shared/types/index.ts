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
