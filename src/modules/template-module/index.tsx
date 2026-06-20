import { HelpCircle, Sparkles } from 'lucide-react';
import { AppModule } from '../../shared/types';

/**
 * Boilerplate blueprint layout representing future extension modules.
 * Developers can copy this folder structure to deploy new tabs instantly.
 */
export const DummyTemplateModule: AppModule = {
  id: 'template-module',
  name: 'Future Module (Template Indicator)',
  icon: <HelpCircle className="h-4 w-4 text-indigo-400" />,
  component: (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center max-w-xl mx-auto my-12 space-y-4 shadow-xl">
      <div className="inline-block bg-indigo-500/10 border border-indigo-500/25 p-4 rounded-full text-indigo-400 animate-pulse">
        <Sparkles className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-bold text-white tracking-wide">Developer Resource: Reusable Module Template</h2>
      <p className="text-xs text-slate-400 leading-relaxed">
        This is a preloaded workspace template tab denoting the extensibility of the Master Barcode suite. 
        Refer to the <code className="bg-slate-950 px-1.5 py-0.5 rounded text-indigo-400">TEMPLATE_GUIDE.md</code> 
        file inside your folder structure to spin up custom features (like Shelf Label or batch carton QR loaders) under 5 minutes without writing any orchestration wrappers!
      </p>
      <div className="pt-2">
        <span className="text-[9.5px] uppercase tracking-wider bg-indigo-600/10 text-indigo-400 px-2.5 py-1 rounded-full font-bold border border-indigo-500/20">
          Coupled to Shared SVG & Print Engines
        </span>
      </div>
    </div>
  )
};
