interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_AUTH_GOOGLE_ENABLED?: string;
  readonly VITE_AUTH_APPLE_ENABLED?: string;
  readonly VITE_PUBLIC_APP_URL?: string;
  readonly VITE_FOUNDER_USER_IDS?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENV?: string;
  readonly VITE_SENTRY_RELEASE?: string;
  readonly VITE_BUILD_FINGERPRINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
