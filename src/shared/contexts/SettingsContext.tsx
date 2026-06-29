import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

export interface AppSettings {
  eanDuplicateEmails: string[];
}

const DEFAULT: AppSettings = { eanDuplicateEmails: [] };

interface ContextValue {
  settings: AppSettings;
  loading: boolean;
  saveSettings: (s: AppSettings) => Promise<void>;
}

const SettingsContext = createContext<ContextValue>({
  settings: DEFAULT,
  loading: false,
  saveSettings: async () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/barcode/settings')
      .then(r => r.json())
      .then((data: AppSettings) => setSettings(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const saveSettings = useCallback(async (next: AppSettings) => {
    await fetch('/api/barcode/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    setSettings(next);
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, loading, saveSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
