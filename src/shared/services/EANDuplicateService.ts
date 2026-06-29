import { Product } from '../types';

const SESSION_KEY = 'ean_duplicate_session_v1';

export interface DuplicateEANEntry {
  ean: string;
  affectedProducts: Array<{ sku: string; productName: string }>;
  timestamp: string;
  module: string;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  products: Product[];
}

/** Returns true when EANUPC is the value that will be printed (not null/empty/"0"). */
export function isEANUPCSelected(ean?: string): boolean {
  const v = ean?.trim() ?? '';
  return v !== '' && v !== '0';
}

/** Queries the backend to check for EAN/SKU duplicates.
 *  In barcode-table mode the backend uses a cross-field JOIN keyed on SKU;
 *  in central-DB mode it falls back to an EAN equality search. */
export async function checkEANDuplicate(ean: string, sku?: string): Promise<DuplicateCheckResult> {
  const res = await fetch('/api/barcode/check-ean-duplicates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ean, sku }),
  });
  if (!res.ok) throw new Error('Duplicate EAN check failed.');
  return res.json();
}

export function getSessionDuplicates(): DuplicateEANEntry[] {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function hasSessionDuplicates(): boolean {
  return getSessionDuplicates().length > 0;
}

/** Adds a duplicate entry to the session record (skips if EAN already recorded). */
export function recordSessionDuplicate(entry: DuplicateEANEntry): void {
  try {
    const existing = getSessionDuplicates();
    if (existing.some(e => e.ean === entry.ean)) return;
    existing.push(entry);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(existing));
  } catch {
    // sessionStorage unavailable — silent fail
  }
}

/**
 * Sends the accumulated session duplicates as a single escalation email,
 * then clears the session record.
 * Returns false and skips silently if there are no pending duplicates.
 */
export async function sendSessionDuplicateEmail(moduleName: string): Promise<{ sent: boolean }> {
  const duplicates = getSessionDuplicates();
  if (!duplicates.length) return { sent: false };

  try {
    const res = await fetch('/api/barcode/send-duplicate-ean-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duplicates, module: moduleName }),
    });
    if (!res.ok) {
      console.error('[EANDuplicate] Email send failed:', await res.text());
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    console.error('[EANDuplicate] Email send error:', err);
    return { sent: false };
  }
}
