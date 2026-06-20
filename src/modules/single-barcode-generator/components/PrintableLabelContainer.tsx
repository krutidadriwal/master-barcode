import { createPortal } from 'react-dom';
import { Product } from '../../../shared/types';
import { BarcodePreview } from './BarcodePreview';

interface PrintableLabelContainerProps {
  product: Product;
  quantity: number;
  batchNo?: string;
}

export function PrintableLabelContainer({ product, quantity, batchNo }: PrintableLabelContainerProps) {
  const labels = Array.from({ length: quantity || 1 });

  const content = (
    <div id="print-only-area" style={{ backgroundColor: '#ffffff' }}>
      {labels.map((_, index) => (
        <div key={index} className="print-label-item">
          <BarcodePreview product={product} scale={1.0} batchNo={batchNo} />
        </div>
      ))}
    </div>
  );

  if (typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }
  return null;
}
