import { useState, useEffect, useRef } from 'react';
import { X, Settings, Mail, Save } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const { settings, loading, saveSettings } = useSettings();
  const [rawInput, setRawInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setSaved(false);
      setRawInput(settings.eanDuplicateEmails.join(', '));
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [open, settings.eanDuplicateEmails]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    const emails = rawInput
      .split(',')
      .map(e => e.trim())
      .filter(e => e.length > 0);
    await saveSettings({ ...settings, eanDuplicateEmails: emails });
    setSaving(false);
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 800);
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="w-full max-w-md mx-4 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <Settings className="h-4 w-4 text-indigo-400" />
            <span className="text-sm font-bold text-white tracking-wide uppercase">Settings</span>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 transition cursor-pointer rounded-lg p-1 hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">EAN Duplicate Email Notifications</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            When a duplicate EAN is detected, an alert email is automatically sent to these addresses. Separate multiple addresses with commas.
          </p>

          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1.5">Recipients</label>
            <textarea
              ref={inputRef}
              value={loading ? 'Loading…' : rawInput}
              onChange={e => setRawInput(e.target.value)}
              disabled={loading}
              placeholder="e.g. ops@company.com, manager@company.com"
              rows={3}
              className="w-full bg-slate-800 border border-slate-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 disabled:opacity-50 resize-none outline-none transition"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Saved to Supabase — shared across all sessions. Leave empty to disable email notifications.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800 bg-slate-950/40">
          <button
            onClick={onClose}
            className="text-sm text-slate-400 hover:text-white font-medium px-4 py-2 rounded-xl hover:bg-slate-800 transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className={`flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition cursor-pointer disabled:opacity-50 ${
              saved ? 'bg-emerald-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            <Save className="h-3.5 w-3.5" />
            {saved ? 'Saved!' : saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>

      </div>
    </div>
  );
}
