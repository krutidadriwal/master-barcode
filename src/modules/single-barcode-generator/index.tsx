import { ReactNode } from 'react';
import { Barcode } from 'lucide-react';
import { AppModule } from '../../shared/types';
import { SingleBarcodeForm } from './components/SingleBarcodeForm';

export const SingleBarcodeGeneratorModule: AppModule = {
  id: 'single-barcode-generator',
  name: 'Single Barcode Generator',
  icon: <Barcode className="h-4 w-4" />,
  component: <SingleBarcodeForm />
};
