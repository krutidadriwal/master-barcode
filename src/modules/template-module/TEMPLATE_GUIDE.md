# Custom Module Template Guide

This directory provides a fully modular, boilerplate blueprint for adding new tabs or generator modules to the **Master Barcode Generator** suite. 

To keep features completely decoupled and maintain production-grade modularity:
1. Every module MUST exist in its own directory under `/src/modules/`.
2. A module must never import code directly from another module directory.
3. Common helpers, fonts, repositories, and print structures MUST reside inside `/src/shared/`.

---

## 📂 Boilerplate File Architecture

```txt
/src/modules/my-new-generator/
├── components/          # Module-specific react visual components
│   ├── MainLayout.tsx   # Primary control interface
│   └── ItemRow.tsx      # Sub-elements
├── services/            # Module Business logic & calculations (e.g., aggregators)
├── api/                 # Endpoint calls proxies (routes through BFF server)
│   └── customApi.ts
├── types/               # Local TypeScript data shapes
│   └── index.ts
├── validators/          # Input checking assertions
│   └── index.ts
├── config/              # Constant options, layout constraints, storage keys
│   └── index.ts
└── index.tsx            # Standard schema file exporting the register descriptor
```

---

## 🛠️ Step-by-Step Implementation

### Step 1: Create local shapes (`types/index.ts`)
```typescript
export interface MyState {
  items: Array<{ key: string; name: string }>;
  isReady: boolean;
}
```

### Step 2: Establish configuration (`config/index.ts`)
```typescript
export const NEW_MODULE_CONFIG = {
  id: 'my-new-generator',
  name: 'Carton Labels',
  storageKey: 'master_barcode_new_gen_v1'
}
```

### Step 3: Implement components & validator
Design the input forms and wire up debounced queries. Reuse `/src/shared/services/BarcodeGeneratorService.ts` for barcode evaluations or layout calculations!

### Step 4: Register your Module inside dashboard!
Ensure your entry `index.tsx` conforms to `AppModule` structure:

```typescript
import { ReactNode } from 'react';
import { Layers } from 'lucide-react';
import { AppModule } from '../../shared/types';
import { MainLayout } from './components/MainLayout';

export const MyNewModule: AppModule = {
  id: 'my-new-generator',
  name: 'Carton Labels',
  icon: <Layers className="h-4 w-4" />,
  component: <MainLayout />
};
```

Open `/src/dashboard/components/ModuleRegistry.ts` and simply import and append `MyNewModule` to the `REGISTERED_MODULES` array. The dashboard auto-refreshes to show your new tab instantly!
