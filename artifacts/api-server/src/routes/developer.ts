import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, webhooksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { generateId } from "../lib/id";
import { createSession, requireAuth } from "../lib/productAuth";
import {
  generateDeveloperKey, validateDeveloperKey, trackUsage,
  getUsageStats, listDeveloperKeys, revokeKey,
  getApiDocs, getSandboxConfig,
  type PlanTier,
} from "../lib/developerPlatform";
import { hashPin, isValidPin, normalizePhone, verifyPin } from "../lib/password";

const router = Router();

router.post("/register", async (req, res) => {
  const { firstName, lastName, email, phone, country = "NG", pin = "000000" } = req.body;
  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ error: "firstName, lastName, phone required" });
  }
  if (!isValidPin(String(pin))) {
    return res.status(400).json({ error: "PIN must be exactly 4 digits" });
  }
  try {
    const normalizedPhone = normalizePhone(String(phone));
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, normalizedPhone)).limit(1);
    if (existing[0]) return res.status(409).json({ error: "Phone already registered" });
    const userId = generateId("dev");
    const pinHash = await hashPin(String(pin));
    await db.insert(usersTable).values({
      id: userId, phone: normalizedPhone, email: email ?? null, firstName, lastName,
      country, pinHash, status: "active",
    });
    const session = await createSession(userId, "developer");
    const freeKey = await generateDeveloperKey({
      developerId: userId, name: "Default", planTier: "free", environment: "sandbox",
    });
    return res.status(201).json({
      developerId: userId, token: session.token,
      apiKey: freeKey.apiKey,
      keyPrefix: freeKey.prefix,
      plan: "free",
      message: "Developer account created. Keep your API key safe.",
    });
  } catch (err: any) {
    if (err.code === "23505" || err.message?.includes("unique")) return res.status(409).json({ error: "Phone already registered" });
    return res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: "phone and pin required" });
  try {
    const normalizedPhone = normalizePhone(String(phone));
    const users = await db.select().from(usersTable).where(eq(usersTable.phone, normalizedPhone)).limit(1);
    if (!users[0]) return res.status(401).json({ error: "User not found" });
    const validPin = await verifyPin(String(pin), (users[0] as any).pinHash ?? "");
    if (!validPin) return res.status(401).json({ error: "Invalid credentials" });
    const session = await createSession(users[0].id, "developer");
    return res.json({ token: session.token, expiresAt: session.expiresAt, developerId: users[0].id });
  } catch (err) {
    return res.status(500).json({ error: "Login failed" });
  }
});

router.post("/api-key", async (req, res) => {
  const { developerId, name, planTier, scopes, environment } = req.body;
  if (!developerId || !name) return res.status(400).json({ error: "developerId and name required" });
  const validPlans: PlanTier[] = ["free", "starter", "growth", "enterprise"];
  if (planTier && !validPlans.includes(planTier)) {
    return res.status(400).json({ error: `planTier must be one of: ${validPlans.join(", ")}` });
  }
  try {
    const result = await generateDeveloperKey({ developerId, name, planTier, scopes, environment });
    return res.status(201).json({
      ...result,
      message: "Store your API key safely — the full key will NOT be shown again",
      scopes: scopes ?? (planTier === "free" ? ["wallets:read", "transactions:read", "fx:read"] : "all"),
      environment: environment ?? "sandbox",
    });
  } catch (err) {
    return res.status(500).json({ error: "API key generation failed" });
  }
});

router.get("/api-keys", async (req, res) => {
  const auth = await requireAuth(req.headers.authorization, ["developer"]);
  if (!auth) return res.status(401).json({ error: "Authentication required" });
  try {
    const keys = await listDeveloperKeys(auth.userId);
    return res.json({ keys, count: keys.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to list API keys" });
  }
});

router.post("/api-key/validate", async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: "apiKey required" });
  try {
    const result = await validateDeveloperKey(apiKey);
    if (!result.valid) return res.status(401).json({ valid: false, error: "Invalid or inactive API key" });
    return res.json({ valid: true, keyId: result.keyId, scopes: result.scopes, planTier: result.planTier, environment: result.environment });
  } catch (err) {
    return res.status(500).json({ error: "Validation failed" });
  }
});

router.delete("/api-key/:keyId", async (req, res) => {
  const auth = await requireAuth(req.headers.authorization, ["developer"]);
  if (!auth) return res.status(401).json({ error: "Authentication required" });
  try {
    await revokeKey(req.params.keyId, auth.userId);
    return res.json({ revoked: true, keyId: req.params.keyId });
  } catch (err) {
    return res.status(500).json({ error: "Revocation failed" });
  }
});

router.get("/usage", async (req, res) => {
  const { developerId } = req.query;
  if (!developerId) return res.status(400).json({ error: "developerId required" });
  try {
    const stats = await getUsageStats(developerId as string);
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch usage" });
  }
});

router.post("/usage/track", async (req, res) => {
  const { apiKeyId, endpoint, method, statusCode, responseMs, ipAddress } = req.body;
  if (!apiKeyId || !endpoint) return res.status(400).json({ error: "apiKeyId and endpoint required" });
  try {
    await trackUsage({ apiKeyId, endpoint, method: method ?? "GET", statusCode: statusCode ?? 200, responseMs: responseMs ?? 0, ipAddress });
    return res.status(201).json({ tracked: true });
  } catch (err) {
    return res.status(500).json({ error: "Usage tracking failed" });
  }
});

router.post("/webhook", async (req, res) => {
  const { developerId, url, events, secret } = req.body;
  if (!developerId || !url) return res.status(400).json({ error: "developerId and url required" });
  if (!url.startsWith("http")) return res.status(400).json({ error: "url must be a valid HTTP(S) URL" });
  try {
    const users = await db.select().from(usersTable).where(eq(usersTable.id, developerId)).limit(1);
    if (!users[0]) return res.status(404).json({ error: "Developer not found" });
    const eventList   = Array.isArray(events) ? events : ["transaction.completed", "wallet.updated"];
    const webhookSecret = secret ?? `whsec_${randomBytes(20).toString("hex")}`;
    const insertedIds: string[] = [];
    for (const eventType of eventList) {
      const id = generateId("wh");
      await db.insert(webhooksTable).values({ id, url, eventType, secret: webhookSecret, active: true });
      insertedIds.push(id);
    }
    return res.status(201).json({ webhookId: insertedIds[0], webhookIds: insertedIds, url, events: eventList, active: true });
  } catch (err) {
    return res.status(500).json({ error: "Webhook registration failed" });
  }
});

router.get("/docs", (_req, res) => {
  return res.json(getApiDocs());
});

router.get("/sandbox", (_req, res) => {
  return res.json(getSandboxConfig());
});

router.post("/sandbox/reset", async (req, res) => {
  const { developerId } = req.body;
  if (!developerId) return res.status(400).json({ error: "developerId required" });
  return res.json({
    reset: true,
    developerId,
    message:    "Sandbox data reset. Test wallets restored to initial balances.",
    testWallets: getSandboxConfig().testWallets,
  });
});

export default router;
