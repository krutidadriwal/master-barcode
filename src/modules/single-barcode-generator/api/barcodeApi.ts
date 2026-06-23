import { Product } from '../../../shared/types';

export class BarcodeApi {
  /**
   * Search for product in the Database Repository via BFF
   */
  static async searchProduct(identifier: string): Promise<Product> {
    const response = await fetch('/api/barcode/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ identifier })
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Product not found for identifier "${identifier}"`);
      }
      const errRes = await response.json().catch(() => ({}));
      throw new Error(errRes.error || 'Transient network failure querying database.');
    }

    return response.json();
  }

  /**
   * Fetches full catalog list from BFF (to display test keys)
   */
  static async fetchAllProducts(): Promise<Product[]> {
    const response = await fetch('/api/barcode/products');
    if (!response.ok) {
      throw new Error('Failed to download product registry checklist.');
    }
    return response.json();
  }

}
