interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENV?: string;
  readonly VITE_SENTRY_RELEASE?: string;
  readonly VITE_BUILD_FINGERPRINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
