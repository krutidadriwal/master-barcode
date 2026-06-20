export interface Product {
  product_id: string;
  sku: string;
  item_name: string;
  mrp: string;
  ean_upc: string;
  custom_ean?: string;
  batch_no?: string;
}
