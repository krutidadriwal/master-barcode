import { ReactNode } from 'react';
import { ClipboardList } from 'lucide-react';
import { AppModule } from '../../shared/types';
import { ProductionOrderBarcodeForm } from './components/ProductionOrderBarcodeForm';

export const ProductionOrderBarcodeModule: AppModule = {
  id: 'production-order-barcode',
  name: 'Production Order Barcode',
  icon: <ClipboardList className="h-4 w-4" />,
  component: <ProductionOrderBarcodeForm />
};
