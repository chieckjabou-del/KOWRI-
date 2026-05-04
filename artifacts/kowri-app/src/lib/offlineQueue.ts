import { buildApiUrl } from "@/lib/api";

// ── KOWRI Offline Action Queue ────────────────────────────────────────────────
//
// Queues financial actions when offline and replays them (with idempotency)
// when the connection is restored. localStorage-backed — safe for reload.

const QUEUE_KEY = "kowri_offline_queue";

export interface QueuedAction {
  id: string;
  type: "transfer" | "deposit" | "collect" | "reconcile" | string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  endpoint: string;
  method: "POST" | "PATCH" | "PUT";
  createdAt: number;
  attempts: number;
}

export type FlushStatus = "flushed" | "partial" | "empty";

// ── Storage helpers ───────────────────────────────────────────────────────────

function getQueue(): QueuedAction[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedAction[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: QueuedAction[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full — silently continue
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function queueAction(action: Omit<QueuedAction, "attempts">): void {
  const queue = getQueue();
  queue.push({ ...action, attempts: 0 });
  saveQueue(queue);
  console.info(`[OfflineQueue] queued action ${action.id} (type: ${action.type})`);
}

export function getQueueLength(): number {
  return getQueue().length;
}

export function clearQueue(): void {
  localStorage.removeItem(QUEUE_KEY);
}

async function executeAction(action: QueuedAction, token: string | null): Promise<void> {
  const url = buildApiUrl(action.endpoint);

  const headers: Record<string, string> = {
    "Content-Type":   "application/json",
    "X-Idempotency-Key": action.idempotencyKey,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(url, {
    method:  action.method,
    headers,
    body:    JSON.stringify(action.payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
}

export async function flushQueue(token: string | null): Promise<FlushStatus> {
  const queue = getQueue();
  if (queue.length === 0) return "empty";

  console.info(`[OfflineQueue] flushing ${queue.length} queued action(s)…`);

  const remaining: QueuedAction[] = [];
  let anySuccess = false;

  for (const action of queue) {
    try {
      await executeAction(action, token);
      anySuccess = true;
      console.info(`[OfflineQueue] replayed action ${action.id} (${action.type})`);
    } catch (err) {
      action.attempts += 1;
      if (action.attempts < 3) {
        remaining.push(action);
        console.warn(`[OfflineQueue] action ${action.id} failed (attempt ${action.attempts}/3):`, err);
      } else {
        console.error(`[OfflineQueue] action ${action.id} dropped after 3 attempts:`, err);
      }
    }
  }

  saveQueue(remaining);

  if (remaining.length === 0) return "flushed";
  if (anySuccess) return "partial";
  return "partial";
}

// ── Auto-flush wiring ─────────────────────────────────────────────────────────
// Call initOfflineQueue(getToken) once at app startup.
// getToken() must return the current auth token synchronously.

let _getToken: (() => string | null) | null = null;

export function initOfflineQueue(getToken: () => string | null): void {
  _getToken = getToken;

  window.addEventListener("online", async () => {
    console.info("[OfflineQueue] connection restored — flushing…");
    await flushQueue(_getToken?.() ?? null);
  });
}
