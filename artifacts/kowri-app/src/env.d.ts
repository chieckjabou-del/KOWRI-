interface ImportMetaEnv {
  readonly VITE_BACKEND_API_BASE?: string;
  readonly VITE_API_LOGS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
