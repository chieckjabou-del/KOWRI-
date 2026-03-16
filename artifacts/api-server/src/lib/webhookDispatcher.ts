import { createHmac } from "crypto";
import { db } from "@workspace/db";
import { webhooksTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

export type WebhookEventType =
  | "transaction.completed"
  | "wallet.balance.updated"
  | "loan.disbursed"
  | "merchant.payment.completed"
  | "fraud.alert.triggered"
  | "settlement.started"
  | "settlement.completed";

interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

function signPayload(payload: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

async function sendWebhook(
  url: string,
  secret: string,
  eventType: string,
  payload: WebhookPayload,
  attempt = 1
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, secret);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kowri-Signature": signature,
        "X-Kowri-Event": eventType,
        "X-Kowri-Timestamp": payload.timestamp,
        "User-Agent": "KOWRI-Webhook/5.0",
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);
    console.log(`[Webhook] Delivered ${eventType} → ${url} (HTTP ${res.status})`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt < 3) {
      const delay = attempt * 1000;
      console.warn(`[Webhook] Attempt ${attempt} failed for ${url} — retrying in ${delay}ms:`, msg);
      await new Promise((r) => setTimeout(r, delay));
      return sendWebhook(url, secret, eventType, payload, attempt + 1);
    }
    console.error(`[Webhook] All ${attempt} attempts failed for ${url}:`, msg);
  }
}

export async function dispatchWebhooks(
  eventType: WebhookEventType | string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const hooks = await db
      .select()
      .from(webhooksTable)
      .where(and(eq(webhooksTable.eventType, eventType), eq(webhooksTable.active, true)));

    if (hooks.length === 0) return;

    const payload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data,
    };

    setImmediate(() => {
      for (const hook of hooks) {
        sendWebhook(hook.url, hook.secret, eventType, payload).catch((err) =>
          console.error("[Webhook] Dispatch error:", err)
        );
      }
    });
  } catch (err) {
    console.error("[Webhook] Failed to query webhooks:", err);
  }
}
