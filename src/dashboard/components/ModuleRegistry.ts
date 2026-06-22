import { AppModule } from '../../shared/types';
import { SingleBarcodeGeneratorModule } from '../../modules/single-barcode-generator';
import { ShipmentBarcodeModule } from '../../modules/shipment-barcode';
import { ProductionOrderBarcodeModule } from '../../modules/production-order-barcode';
import { DummyTemplateModule } from '../../modules/template-module';

export const REGISTERED_MODULES: AppModule[] = [
  SingleBarcodeGeneratorModule,
  ShipmentBarcodeModule,
  ProductionOrderBarcodeModule,
  DummyTemplateModule
];
