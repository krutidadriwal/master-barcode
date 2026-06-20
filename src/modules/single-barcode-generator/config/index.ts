export const SINGLE_BARCODE_CONFIG = {
  id: 'single-barcode-generator',
  name: 'Single Barcode Generator',
  label: {
    widthMm: 50,
    heightMm: 25,
    websiteUrl: 'www.cubelelo.com'
  },
  limits: {
    maxQuantity: 1000,
    defaultQuantity: 1
  },
  storageKeys: {
    lastGeneration: 'master_barcode_generator_last_gen'
  }
};
