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
  status: number,
  message?: string,
  durationMs?: number,
): void {
  trackEvent("api-failure", "api.request.failed", {
    path,
    status,
    message: message ?? "",
    durationMs: durationMs ?? null,
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

export function readMonitorEvents(): MonitorEvent[] {
  return safeRead();
}
