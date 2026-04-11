interface ImportMetaEnv {
  readonly VITE_USE_REAL_API?: string;
  readonly VITE_API_LOGS?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENV?: string;
  readonly VITE_SENTRY_RELEASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
