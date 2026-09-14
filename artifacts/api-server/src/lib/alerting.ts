// ── Outbound alerting ────────────────────────────────────────────────────────
//
// Incidents are stored in the database, but a stored incident nobody reads is
// silence. When ALERT_WEBHOOK_URL is set, every alert is also POSTed there as
// JSON, signed with SIGNING_SECRET (HMAC-SHA256 over the body, header
// X-Akwe-Signature) so the receiver (chat channel, pager, ticketing) can
// authenticate it. Delivery is best-effort and never blocks the caller; a
// failed delivery is logged so the reconciliation runbook can spot it.
//
// Sources: financial reconciliation anomalies, kill switch changes, cash-in
// requests overdue, secrets review errors, and the operator test endpoint.

import { createHmac } from "crypto";
import { logIncident } from "./incidentStore";

export type AlertSeverity = "info" | "warning" | "critical";
export interface Alert {
  severity: AlertSeverity;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export function alertingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.ALERT_WEBHOOK_URL === "string" && /^https?:\/\//.test(env.ALERT_WEBHOOK_URL);
}

let deliveries = { sent: 0, failed: 0, lastError: "" as string | null, lastSentAt: null as string | null };
export function alertingStats() { return { configured: alertingConfigured(), ...deliveries }; }

export async function sendAlert(alert: Alert): Promise<boolean> {
  logIncident({ type: `alert:${alert.type}`, action: alert.severity, result: alert.message });
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!alertingConfigured()) return false;
  const body = JSON.stringify({
    service: "akwe-api", environment: process.env.NODE_ENV ?? "development",
    at: new Date().toISOString(), ...alert,
  });
  const secret = process.env.SIGNING_SECRET ?? "";
  const signature = secret ? createHmac("sha256", secret).update(body).digest("hex") : "";
  try {
    const res = await fetch(url!, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(signature ? { "X-Akwe-Signature": `sha256=${signature}` } : {}) },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
    deliveries = { ...deliveries, sent: deliveries.sent + 1, lastSentAt: new Date().toISOString() };
    return true;
  } catch (err) {
    deliveries = { ...deliveries, failed: deliveries.failed + 1, lastError: err instanceof Error ? err.message : String(err) };
    console.error(`[Alerting] delivery failed (${alert.type}): ${deliveries.lastError}`);
    return false;
  }
}

// Fire-and-forget variant for synchronous call sites.
export function alert(a: Alert): void {
  void sendAlert(a);
}
