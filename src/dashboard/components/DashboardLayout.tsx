import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { REGISTERED_MODULES } from './ModuleRegistry';
import { Layers, HardDrive, ShieldCheck, Heart, RefreshCw, CheckCircle2, AlertCircle, Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ProductMasterSyncResult } from '../../shared/types';
import { SettingsModal } from '../../shared/components/SettingsModal';

type SyncStatus = { status: 'idle' } | { status: 'loading' } | { status: 'success'; result: ProductMasterSyncResult } | { status: 'error'; error: string };

export function DashboardLayout() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const activeModuleId = moduleId || REGISTERED_MODULES[0].id;
  const [syncState, setSyncState] = useState<SyncStatus>({ status: 'idle' });
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleSyncProductMaster = async () => {
    if (syncState.status === 'loading') return;
    setSyncState({ status: 'loading' });
    try {
      const res = await fetch('/api/product-master/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed.');
      setSyncState({ status: 'success', result: { inserted: data.inserted, updated: data.updated, deleted: data.deleted, total: data.total } });
    } catch (err: any) {
      setSyncState({ status: 'error', error: err.message || 'Sync failed.' });
    }
  };

  // Auto load active state
  const activeModule = REGISTERED_MODULES.find(m => m.id === activeModuleId) || REGISTERED_MODULES[0];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500/30 flex flex-col justify-between">
      
      {/* Top Header Rail */}
      <header className="border-b border-slate-800 bg-slate-900/40 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          
          {/* Logo Brand info */}
          <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-xl text-white shadow-lg shadow-indigo-600/20">
              <Layers className="h-5 w-5" />
            </div>
            <div>
              <span className="text-md font-bold text-white tracking-widest uppercase">Master Barcode Suite</span>
              <span className="hidden sm:inline bg-indigo-500/10 border border-indigo-500/25 text-indigo-400 text-[10px] font-bold px-2 py-0.5 rounded-md ml-2.5 uppercase tracking-wider">
                Enterprise v4.2
              </span>
            </div>
          </div>

          {/* Core System Status + Sync */}
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <div className="hidden md:flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-3 py-1 rounded-full">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <span>BFF: <strong className="text-white">Active</strong></span>
            </div>
            <div className="hidden sm:flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-3 py-1 rounded-full">
              <HardDrive className="h-4 w-4 text-indigo-400" />
              <span>Product Master: <strong className="text-white">Local</strong></span>
            </div>

            {/* Sync result status pill */}
            {syncState.status === 'success' && (
              <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 px-3 py-1 rounded-full text-[10px] font-semibold whitespace-nowrap">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>+{syncState.result.inserted} / ~{syncState.result.updated} / -{syncState.result.deleted} / {syncState.result.total} total</span>
              </div>
            )}
            {syncState.status === 'error' && (
              <div className="flex items-center gap-1.5 bg-red-500/10 border border-red-500/25 text-red-400 px-3 py-1 rounded-full text-[10px] font-semibold whitespace-nowrap" title={syncState.error}>
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>Sync Failed</span>
              </div>
            )}

            {/* Sync button */}
            <button
              onClick={handleSyncProductMaster}
              disabled={syncState.status === 'loading'}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-3.5 py-1.5 rounded-xl text-[11px] transition cursor-pointer whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncState.status === 'loading' ? 'animate-spin' : ''}`} />
              {syncState.status === 'loading' ? 'Syncing…' : 'Sync Product Master'}
            </button>

            {/* Settings gear */}
            <button
              onClick={() => setShowSettings(true)}
              title="Settings"
              className="flex items-center justify-center h-8 w-8 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-700/50 transition cursor-pointer"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>

        </div>
      </header>

      {/* Body: Vertical Nav Sidebar + Content */}
      <div className="flex-grow flex w-full max-w-7xl mx-auto items-stretch">

        {/* Vertical Module Nav Sidebar */}
        <aside
          className={`shrink-0 border-r border-slate-800 bg-slate-900/40 backdrop-blur-md flex flex-col py-4 transition-all duration-200 ease-in-out ${
            sidebarCollapsed ? 'w-16' : 'w-60'
          }`}
        >
          <div className={`flex items-center mb-3 px-3 ${sidebarCollapsed ? 'justify-center' : 'justify-between'}`}>
            {!sidebarCollapsed && (
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Modules</span>
            )}
            <button
              onClick={() => setSidebarCollapsed((v) => !v)}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="flex items-center justify-center h-7 w-7 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 border border-transparent hover:border-slate-700/50 transition cursor-pointer shrink-0"
            >
              {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          </div>

          <nav className="flex flex-col gap-1 px-2">
            {REGISTERED_MODULES.map((m) => {
              const isActive = m.id === activeModuleId;
              return (
                <Link
                  key={m.id}
                  to={`/${m.id}`}
                  title={sidebarCollapsed ? m.name : undefined}
                  className={`relative flex items-center gap-2.5 py-2.5 px-3 text-xs font-bold uppercase tracking-wider rounded-lg transition duration-150 cursor-pointer ${
                    sidebarCollapsed ? 'justify-center' : ''
                  } ${
                    isActive
                      ? 'text-white bg-slate-900 border border-slate-700/60 shadow-lg'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/30'
                  }`}
                >
                  {m.icon}
                  {!sidebarCollapsed && <span className="truncate">{m.name}</span>}
                  {isActive && (
                    <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-gradient-to-b from-indigo-500 to-indigo-400 rounded-full"></span>
                  )}
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Content Wrapper */}
        <main className="flex-grow w-full px-4 sm:px-6 lg:px-8 py-8 min-w-0">
          {/* Mounted Active Tab Area with Elegant Motion Transitions */}
          <div className="min-h-[60vh]">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeModuleId}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.18, ease: 'easeInOut' }}
                className="outline-none"
              >
                {activeModule.component}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>

      </div>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />

      {/* Workspace Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-1">
            <span>Powered by</span>
            <a href="https://www.cubelelo.com" target="_blank" rel="noreferrer" className="text-slate-400 hover:text-indigo-400 font-semibold underline">Cubelelo Systems</a>
            <span>• Isolated BFF Environment</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span>Developed with</span>
            <Heart className="h-3 w-3 text-red-500 fill-red-500" />
            <span>for thermal print precision</span>
          </div>
        </div>
      </footer>

    </div>
  );
}
