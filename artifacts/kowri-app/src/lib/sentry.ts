import * as Sentry from "@sentry/react";
import { replayIntegration } from "@sentry/react";

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
const ENVIRONMENT = import.meta.env.VITE_SENTRY_ENV ?? import.meta.env.MODE;
const RELEASE = import.meta.env.VITE_SENTRY_RELEASE;
const SENTRY_ENABLED = Boolean(SENTRY_DSN);

export function initSentry(): void {
  if (!SENTRY_ENABLED) return;

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: ENVIRONMENT,
    release: RELEASE,
    integrations: [Sentry.browserTracingIntegration(), replayIntegration()],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.1,
  });
}

export function captureException(error: unknown, context?: Parameters<typeof Sentry.captureException>[1]): void {
  if (!SENTRY_ENABLED) return;
  Sentry.captureException(error, context);
}
