type MonitorEventType = "error" | "api-failure" | "load-time" | "ux-action";

interface MonitorEvent {
  type: MonitorEventType;
  name: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}

const MAX_EVENTS = 120;
const STORAGE_KEY = "akwe-frontend-monitor-v1";

function canStore(): boolean {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function safeRead(): MonitorEvent[] {
  if (!canStore()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MonitorEvent[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.type === "string" &&
        typeof item.name === "string" &&
        Number.isFinite(item.timestamp),
    );
  } catch {
    return [];
  }
}

function safeWrite(events: MonitorEvent[]): void {
  if (!canStore()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // swallow quota/storage failures
  }
}

export function trackEvent(
  type: MonitorEventType,
  name: string,
  payload?: Record<string, unknown>,
): void {
  const event: MonitorEvent = {
    type,
    name,
    timestamp: Date.now(),
    payload,
  };
  const events = safeRead();
  events.push(event);
  safeWrite(events);
}

export function trackApiFailure(
  path: string,
  method: string,
  status: number,
  message?: string,
  durationMs?: number,
): void {
  trackEvent("api-failure", "api.request.failed", {
    path,
    method,
    status,
    message: message ?? "",
    durationMs: durationMs ?? null,
  });
}

export function trackApiLatency(path: string, durationMs: number, method?: string): void {
  trackEvent("load-time", "api.request.latency", {
    path,
    method: method ?? "GET",
    durationMs,
  });
}

export function trackLoadTime(name: string, durationMs: number): void {
  trackEvent("load-time", name, { durationMs });
}

export function trackUxAction(name: string, payload?: Record<string, unknown>): void {
  trackEvent("ux-action", name, payload);
}

export function trackCriticalError(message: string, source?: string): void {
  trackEvent("error", "runtime.error", { message, source: source ?? "unknown" });
}

export function monitorCriticalError(
  error: unknown,
  context?: { source?: string; componentStack?: string },
): void {
  trackCriticalError(
    error instanceof Error ? error.message : String(error ?? "unknown"),
    context?.source,
  );
  if (context?.componentStack) {
    trackEvent("error", "runtime.error.stack", { componentStack: context.componentStack });
  }
}

export function trackApiError(input: {
  endpoint: string;
  method?: string;
  status: number;
  message?: string;
}): void {
  trackApiFailure(
    input.endpoint,
    input.method ?? "GET",
    input.status,
    input.message ?? "",
  );
  trackEvent("api-failure", "api.request.meta", {
    endpoint: input.endpoint,
    method: input.method ?? "GET",
  });
}

export function trackOfflineQueueFlush(payload: {
  attempted: number;
  replayed: number;
  dropped: number;
  remaining: number;
}): void {
  trackEvent("ux-action", "offline.queue.flush", payload);
}

export function initFrontendMonitor(): void {
  if (typeof window === "undefined" || typeof performance === "undefined") return;
  const entries = performance.getEntriesByType("navigation");
  const nav = entries[0] as PerformanceNavigationTiming | undefined;
  if (nav?.domContentLoadedEventEnd) {
    const loadMs = Math.max(0, nav.domContentLoadedEventEnd - nav.startTime);
    trackLoadTime("app.dom-content-loaded", Math.round(loadMs));
  }
}

export function trackApiCall(payload: {
  route: string;
  status: "ok" | "error";
  latencyMs: number;
}): () => void {
  trackEvent("ux-action", "api.call.marker", payload);
  return () => undefined;
}

export function readMonitorEvents(): MonitorEvent[] {
  return safeRead();
}
