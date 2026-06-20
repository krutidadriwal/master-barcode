export type BarcodeType = 'EAN13' | 'UPC' | 'CODE128';

export class BarcodeGeneratorService {
  /**
   * Auto-detects the barcode format based on the given string.
   * - EAN-13: 13 digits (numeric)
   * - UPC-A: 12 digits (numeric)
   * - Code 128: default fallback
   */
  static detectFormat(value: string): BarcodeType {
    const cleanValue = value.trim();
    const isNumeric = /^\d+$/.test(cleanValue);

    if (isNumeric && cleanValue.length === 13) {
      return 'EAN13';
    } else if (isNumeric && cleanValue.length === 12) {
      return 'UPC';
    } else {
      return 'CODE128';
    }
  }

  /**
   * Helper to validate if the string is compatible with the detected format.
   * (e.g. EAN13 should have standard checksum or just be valid numbers)
   */
  static validateValue(value: string, format: BarcodeType): { isValid: boolean; error?: string } {
    const cleanValue = value.trim();
    if (!cleanValue) {
      return { isValid: false, error: 'Value is empty.' };
    }

    if (format === 'EAN13') {
      if (!/^\d{13}$/.test(cleanValue)) {
        return { isValid: false, error: 'EAN-13 must be exactly 13 digits.' };
      }
    } else if (format === 'UPC') {
      if (!/^\d{12}$/.test(cleanValue)) {
        return { isValid: false, error: 'UPC must be exactly 12 digits.' };
      }
    }

    return { isValid: true };
  }
}
