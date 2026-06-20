import { Ship } from 'lucide-react';
import { AppModule } from '../../shared/types';
import { ShipmentBarcodeForm } from './components/ShipmentBarcodeForm';

export const ShipmentBarcodeModule: AppModule = {
  id: 'shipment-barcode',
  name: 'Shipment Barcode',
  icon: <Ship className="h-4 w-4" />,
  component: <ShipmentBarcodeForm />
};
