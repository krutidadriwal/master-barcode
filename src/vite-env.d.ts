/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PDF_ENABLE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
