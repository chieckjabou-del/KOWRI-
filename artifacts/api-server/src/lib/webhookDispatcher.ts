import { createHmac } from "crypto";
import { db } from "@workspace/db";
import { webhooksTable, merchantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

export type WebhookEventType =
  | "transaction.completed"
  | "wallet.balance.updated"
  | "loan.disbursed"
  | "merchant.payment.completed"
  | "fraud.alert.triggered"
  | "settlement.started"
  | "settlement.completed";

export const SYSTEM_WEBHOOK_OWNER = "system";

interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

function extractHttpStatus(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
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

    const response = await fetch(url, {
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
      redirect: "manual",
    });

    clearTimeout(timer);
    const httpStatus = extractHttpStatus(response);
    console.log(`[Webhook] Delivered ${eventType} → ${url} (HTTP ${httpStatus ?? "unknown"})`);
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

const OWNER_FIELDS = ["userId", "ownerId", "developerId", "fromUserId", "toUserId", "recipientUserId", "merchantUserId"];

// A hook only receives an event if it is platform-owned or the event is about its owner.
async function resolveEventOwners(data: Record<string, unknown>): Promise<Set<string>> {
  const owners = new Set<string>();
  for (const field of OWNER_FIELDS) {
    const v = data[field];
    if (typeof v === "string" && v) owners.add(v);
  }
  const merchantId = data.merchantId;
  if (typeof merchantId === "string" && merchantId) {
    const [merchant] = await db
      .select({ userId: merchantsTable.userId })
      .from(merchantsTable)
      .where(eq(merchantsTable.id, merchantId))
      .limit(1);
    if (merchant) owners.add(merchant.userId);
  }
  return owners;
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

    const owners = await resolveEventOwners(data);
    const eligible = hooks.filter(
      (hook) => hook.ownerId === SYSTEM_WEBHOOK_OWNER || (!!hook.ownerId && owners.has(hook.ownerId))
    );
    if (eligible.length === 0) return;

    const payload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data,
    };

    setImmediate(() => {
      for (const hook of eligible) {
        sendWebhook(hook.url, hook.secret, eventType, payload).catch((err) =>
          console.error("[Webhook] Dispatch error:", err)
        );
      }
    });
  } catch (err) {
    console.error("[Webhook] Failed to query webhooks:", err);
  }
}
