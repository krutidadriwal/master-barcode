import { BarcodeGeneratorService } from '../../../shared/services/BarcodeGeneratorService';

export class SingleBarcodeValidator {
  /**
   * Validates the input search identifier (EAN/UPC/SKU value).
   */
  static validateIdentifier(identifier: string): { isValid: boolean; error?: string } {
    const value = identifier.trim();
    if (!value) {
      return { isValid: false, error: 'Identifier cannot be empty. Please enter or paste an SKU, EAN, or UPC.' };
    }

    if (value.length < 3) {
      return { isValid: false, error: 'Identifier must be at least 3 characters long.' };
    }

    return { isValid: true };
  }

  /**
   * Ensures printing quantity is appropriate.
   */
  static validateQuantity(quantity: number): { isValid: boolean; error?: string } {
    if (isNaN(quantity) || quantity < 1) {
      return { isValid: false, error: 'Quantity must be 1 or higher.' };
    }

    if (quantity > 1000) {
      return { isValid: false, error: 'For system performance, batch size is limited to 1,000 labels per print task.' };
    }

    return { isValid: true };
  }
}
