// ── Outbound SMS ─────────────────────────────────────────────────────────────
// A thin provider abstraction so the verification flow does not depend on one
// gateway. SMS_PROVIDER:
//   "log"  — prints the message (development, tests)
//   "http" — POSTs {to, message} as JSON to SMS_WEBHOOK_URL with a bearer
//            SMS_WEBHOOK_TOKEN; any gateway (Twilio proxy, Orange, MTN
//            aggregator) can sit behind that endpoint.
//   "none" — sending is disabled (verification cannot complete)

export type SmsProvider = "log" | "http" | "none";

export function smsProvider(): SmsProvider {
  const p = (process.env.SMS_PROVIDER ?? (process.env.NODE_ENV === "production" ? "none" : "log")).toLowerCase();
  return p === "http" || p === "none" ? p : "log";
}

export async function sendSms(to: string, message: string): Promise<void> {
  const provider = smsProvider();
  if (provider === "log") {
    console.log(`[SMS:log] to=${to} :: ${message}`);
    return;
  }
  if (provider === "none") {
    throw new Error("SMS sending is disabled (SMS_PROVIDER=none)");
  }
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url) throw new Error("SMS_WEBHOOK_URL is required when SMS_PROVIDER=http");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify({ to, message }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`SMS gateway answered HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
