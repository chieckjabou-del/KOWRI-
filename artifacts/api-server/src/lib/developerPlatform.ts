import { db } from "@workspace/db";
import {
  developerApiKeysTable,
  developerUsageLogsTable,
} from "@workspace/db";
import { eq, and, gte, sql, desc, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";
import { generateId } from "./id";

export type PlanTier = "free" | "starter" | "growth" | "enterprise";

const PLAN_LIMITS: Record<PlanTier, { daily: number; monthly: number; ratePerMin: number }> = {
  free:       { daily: 1_000,    monthly: 10_000,   ratePerMin: 60   },
  starter:    { daily: 10_000,   monthly: 100_000,  ratePerMin: 300  },
  growth:     { daily: 100_000,  monthly: 1_000_000, ratePerMin: 1000 },
  enterprise: { daily: 10_000_000, monthly: 100_000_000, ratePerMin: 10000 },
};

const ALL_SCOPES = [
  "wallets:read", "wallets:write",
  "transactions:read", "transactions:write",
  "users:read", "merchants:read", "merchants:write",
  "fx:read", "analytics:read",
];

const FREE_SCOPES = ["wallets:read", "transactions:read", "fx:read"];

export async function generateDeveloperKey(opts: {
  developerId: string;
  name:        string;
  planTier?:   PlanTier;
  scopes?:     string[];
  environment?: "sandbox" | "production";
}): Promise<{ keyId: string; apiKey: string; prefix: string }> {
  const tier   = opts.planTier ?? "free";
  const limits = PLAN_LIMITS[tier];
  const raw    = randomBytes(32).toString("hex");
  const prefix = `kowri_${tier.slice(0, 3)}_${randomBytes(4).toString("hex")}`;
  const apiKey = `${prefix}_${raw}`;
  const hash   = createHash("sha256").update(apiKey).digest("hex");
  const id     = generateId("devk");

  const scopes = opts.scopes ?? (tier === "free" ? FREE_SCOPES : ALL_SCOPES);

  await db.insert(developerApiKeysTable).values({
    id,
    developerId:  opts.developerId,
    name:         opts.name,
    keyPrefix:    prefix,
    keyHash:      hash,
    scopes,
    planTier:     tier,
    active:       true,
    dailyLimit:   limits.daily,
    monthlyLimit: limits.monthly,
    requestCount: 0,
    environment:  opts.environment ?? "sandbox",
  });

  return { keyId: id, apiKey, prefix };
}

export async function validateDeveloperKey(apiKey: string): Promise<{
  valid:       boolean;
  keyId?:      string;
  developerId?: string;
  scopes?:     string[];
  planTier?:   string;
  environment?: string;
}> {
  const hash = createHash("sha256").update(apiKey).digest("hex");
  const rows = await db.select()
    .from(developerApiKeysTable)
    .where(and(eq(developerApiKeysTable.keyHash, hash), eq(developerApiKeysTable.active, true)))
    .limit(1);

  if (!rows[0]) return { valid: false };

  await db.update(developerApiKeysTable).set({
    lastUsedAt:   new Date(),
    requestCount: sql`${developerApiKeysTable.requestCount} + 1`,
  }).where(eq(developerApiKeysTable.id, rows[0].id));

  return {
    valid:       true,
    keyId:       rows[0].id,
    developerId: rows[0].developerId,
    scopes:      rows[0].scopes as string[],
    planTier:    rows[0].planTier,
    environment: rows[0].environment,
  };
}

export async function trackUsage(opts: {
  apiKeyId:   string;
  endpoint:   string;
  method:     string;
  statusCode: number;
  responseMs: number;
  ipAddress?: string;
}): Promise<void> {
  await db.insert(developerUsageLogsTable).values({
    id:         generateId("ulog"),
    apiKeyId:   opts.apiKeyId,
    endpoint:   opts.endpoint,
    method:     opts.method,
    statusCode: opts.statusCode,
    responseMs: opts.responseMs,
    ipAddress:  opts.ipAddress,
  });
}

export async function getUsageStats(developerId: string) {
  const keys = await db.select().from(developerApiKeysTable)
    .where(eq(developerApiKeysTable.developerId, developerId));

  if (!keys.length) return { keys: [], totalRequests: 0, byEndpoint: {} };

  const keyIds = keys.map(k => k.id);
  const since  = new Date(Date.now() - 30 * 86400_000);

  if (keyIds.length === 0) {
    return { keys: [], totalRequests: 0, byEndpoint: {}, period: "last_30_days" };
  }

  const usageRows = await db.select({
    apiKeyId:   developerUsageLogsTable.apiKeyId,
    endpoint:   developerUsageLogsTable.endpoint,
    method:     developerUsageLogsTable.method,
    cnt:        sql<number>`count(*)`,
    avgMs:      sql<number>`avg(${developerUsageLogsTable.responseMs})`,
    errors:     sql<number>`sum(case when ${developerUsageLogsTable.statusCode} >= 400 then 1 else 0 end)`,
  })
    .from(developerUsageLogsTable)
    .where(
      and(
        inArray(developerUsageLogsTable.apiKeyId, keyIds),
        gte(developerUsageLogsTable.createdAt, since),
      )
    )
    .groupBy(developerUsageLogsTable.apiKeyId, developerUsageLogsTable.endpoint, developerUsageLogsTable.method);

  const totalRequests = usageRows.reduce((s, r) => s + Number(r.cnt), 0);
  const byEndpoint    = usageRows.reduce<Record<string, { count: number; avgMs: number; errors: number }>>((acc, r) => {
    const key = `${r.method} ${r.endpoint}`;
    acc[key]  = { count: Number(r.cnt), avgMs: Math.round(Number(r.avgMs)), errors: Number(r.errors) };
    return acc;
  }, {});

  return {
    keys: keys.map(k => ({
      keyId:        k.id,
      name:         k.name,
      prefix:       k.keyPrefix,
      planTier:     k.planTier,
      environment:  k.environment,
      active:       k.active,
      requestCount: k.requestCount,
      dailyLimit:   k.dailyLimit,
      lastUsedAt:   k.lastUsedAt,
    })),
    totalRequests,
    byEndpoint,
    period: "last_30_days",
  };
}

export async function listDeveloperKeys(developerId: string) {
  return db.select({
    id: developerApiKeysTable.id, name: developerApiKeysTable.name,
    keyPrefix: developerApiKeysTable.keyPrefix, planTier: developerApiKeysTable.planTier,
    active: developerApiKeysTable.active, environment: developerApiKeysTable.environment,
    scopes: developerApiKeysTable.scopes, requestCount: developerApiKeysTable.requestCount,
    dailyLimit: developerApiKeysTable.dailyLimit, lastUsedAt: developerApiKeysTable.lastUsedAt,
    createdAt: developerApiKeysTable.createdAt,
  }).from(developerApiKeysTable).where(eq(developerApiKeysTable.developerId, developerId));
}

export async function revokeKey(keyId: string, developerId: string): Promise<boolean> {
  await db.update(developerApiKeysTable).set({ active: false })
    .where(and(eq(developerApiKeysTable.id, keyId), eq(developerApiKeysTable.developerId, developerId)));
  return true;
}

export function getApiDocs() {
  return {
    version:   "5.0.0",
    title:     "KOWRI API Platform",
    baseUrl:   "https://api.kowri.io/v1",
    authScheme: "Bearer <api_key>",
    endpoints: [
      { method: "POST", path: "/wallet/create",       scope: "wallets:write",        description: "Create a wallet" },
      { method: "GET",  path: "/wallet/balance",       scope: "wallets:read",         description: "Get wallet balance" },
      { method: "POST", path: "/wallet/transfer",      scope: "wallets:write",        description: "P2P transfer" },
      { method: "GET",  path: "/wallet/transactions",  scope: "transactions:read",    description: "Transaction history" },
      { method: "POST", path: "/wallet/qr/generate",  scope: "wallets:read",         description: "Generate QR code" },
      { method: "POST", path: "/merchant/create",      scope: "merchants:write",      description: "Create merchant" },
      { method: "POST", path: "/merchant/payment",     scope: "merchants:write",      description: "Accept payment" },
      { method: "GET",  path: "/merchant/payments",    scope: "merchants:read",       description: "List payments" },
      { method: "GET",  path: "/merchant/settlements", scope: "merchants:read",       description: "Settlement history" },
      { method: "POST", path: "/merchant/payment-link", scope: "merchants:write",    description: "Create payment link" },
      { method: "POST", path: "/merchant/invoice",     scope: "merchants:write",      description: "Create invoice" },
      { method: "GET",  path: "/fx/rates/:from/:to",   scope: "fx:read",              description: "FX rate lookup" },
      { method: "GET",  path: "/analytics/overview",   scope: "analytics:read",       description: "Platform analytics" },
    ],
    rateLimits: PLAN_LIMITS,
    sdks: ["JavaScript/TypeScript", "Python", "Go", "Java", "PHP"],
    environments: { sandbox: "https://sandbox.kowri.io/v1", production: "https://api.kowri.io/v1" },
  };
}

export function getSandboxConfig() {
  return {
    environment:  "sandbox",
    description:  "Sandbox environment — transactions are simulated, no real money moves",
    testWallets: [
      { id: "sandbox-wallet-001", currency: "XOF", balance: 100_000,   label: "High-balance XOF wallet" },
      { id: "sandbox-wallet-002", currency: "USD", balance: 1_000,     label: "USD wallet" },
      { id: "sandbox-wallet-003", currency: "EUR", balance: 500,       label: "EUR wallet" },
    ],
    testCards: [
      { number: "4000 0000 0000 0002", result: "success" },
      { number: "4000 0000 0000 0069", result: "expired_card" },
      { number: "4000 0000 0000 0119", result: "processing_error" },
    ],
    webhookTestEndpoint: "https://webhook.site",
    note: "All amounts in sandbox are in XOF cents equivalent",
  };
}
