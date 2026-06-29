import { DashboardLayout } from './dashboard/components/DashboardLayout';
import { SettingsProvider } from './shared/contexts/SettingsContext';

export default function App() {
  return (
    <SettingsProvider>
      <DashboardLayout />
    </SettingsProvider>
  );
}
