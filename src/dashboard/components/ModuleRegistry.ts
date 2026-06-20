import { AppModule } from '../../shared/types';
import { SingleBarcodeGeneratorModule } from '../../modules/single-barcode-generator';
import { ShipmentBarcodeModule } from '../../modules/shipment-barcode';
import { DummyTemplateModule } from '../../modules/template-module';

/**
 * Registry block. Add any new modules (e.g. shelf, carton or shipping labels)
 * here to register them inside the live dashboard workspace automatically.
 */
export const REGISTERED_MODULES: AppModule[] = [
  SingleBarcodeGeneratorModule,
  ShipmentBarcodeModule,
  DummyTemplateModule
];
