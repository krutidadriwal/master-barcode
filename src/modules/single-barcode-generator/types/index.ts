import { Product } from '../../../shared/types';

export interface SingleBarcodeState {
  identifier: string;
  quantity: number;
  product: Product | null;
  loading: boolean;
  error: string | null;
}
