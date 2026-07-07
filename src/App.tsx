import { Routes, Route, Navigate } from 'react-router-dom';
import { DashboardLayout } from './dashboard/components/DashboardLayout';
import { SettingsProvider } from './shared/contexts/SettingsContext';
import { REGISTERED_MODULES } from './dashboard/components/ModuleRegistry';

export default function App() {
  return (
    <SettingsProvider>
      <Routes>
        <Route path="/" element={<Navigate to={`/${REGISTERED_MODULES[0].id}`} replace />} />
        <Route path="/:moduleId" element={<DashboardLayout />} />
        <Route path="*" element={<Navigate to={`/${REGISTERED_MODULES[0].id}`} replace />} />
      </Routes>
    </SettingsProvider>
  );
}
