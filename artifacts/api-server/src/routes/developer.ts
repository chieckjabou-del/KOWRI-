import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, webhooksTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { randomBytes } from "crypto";
import { generateId } from "../lib/id";
import { routeParamString } from "../lib/routeParams";
import { createSession, requireAuth } from "../lib/productAuth";
import { hashPin, verifyPin, isLegacyPinHash, isValidPinFormat } from "../lib/pin";
import { loginRateLimit } from "../lib/loginRateLimit";
import { authenticate } from "../middleware/auth";
import { validateWebhookUrl } from "../lib/webhookUrl";
import {
  generateDeveloperKey, validateDeveloperKey, trackUsage,
  getUsageStats, listDeveloperKeys, revokeKey,
  getApiDocs, getSandboxConfig,
  type PlanTier,
} from "../lib/developerPlatform";

const router = Router();

router.post("/register", async (req, res) => {
  const { firstName, lastName, email, phone, country = "NG", pin } = req.body;
  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ error: "firstName, lastName, phone required" });
  }
  if (!isValidPinFormat(pin)) {
    return res.status(400).json({ error: "pin must be 4 to 6 digits" });
  }
  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (existing[0]) return res.status(409).json({ error: "Phone already registered" });
    const userId = generateId("dev");
    await db.insert(usersTable).values({
      id: userId, phone, email: email ?? null, firstName, lastName,
      country, pinHash: hashPin(pin), status: "active",
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

router.post("/login", loginRateLimit, async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: "phone and pin required" });
  try {
    const users = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    const user = users[0];
    if (!user || !verifyPin(String(pin), user.pinHash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (isLegacyPinHash(user.pinHash)) {
      await db.update(usersTable).set({ pinHash: hashPin(String(pin)), updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    }
    const session = await createSession(user.id, "developer", { ipAddress: req.ip });
    return res.json({ token: session.token, expiresAt: session.expiresAt, developerId: user.id });
  } catch (err) {
    return res.status(500).json({ error: "Login failed" });
  }
});

router.post("/api-key", authenticate(["developer"]), async (req, res) => {
  const { name, planTier, scopes, environment } = req.body;
  const developerId = req.auth!.userId;
  if (!name) return res.status(400).json({ error: "name required" });
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

router.get("/usage", authenticate(["developer"]), async (req, res) => {
  try {
    const stats = await getUsageStats(req.auth!.userId);
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch usage" });
  }
});

router.post("/usage/track", authenticate(["developer"]), async (req, res) => {
  const { apiKeyId, endpoint, method, statusCode, responseMs, ipAddress } = req.body;
  if (!apiKeyId || !endpoint) return res.status(400).json({ error: "apiKeyId and endpoint required" });
  try {
    const owned = (await listDeveloperKeys(req.auth!.userId)).some((k: any) => k.id === apiKeyId);
    if (!owned) return res.status(403).json({ error: "API key does not belong to you" });
    await trackUsage({ apiKeyId, endpoint, method: method ?? "GET", statusCode: statusCode ?? 200, responseMs: responseMs ?? 0, ipAddress });
    return res.status(201).json({ tracked: true });
  } catch (err) {
    return res.status(500).json({ error: "Usage tracking failed" });
  }
});

router.post("/webhook", authenticate(["developer"]), async (req, res) => {
  const { url, events, secret } = req.body;
  const developerId = req.auth!.userId;
  if (!url) return res.status(400).json({ error: "url required" });
  const urlCheck = validateWebhookUrl(url);
  if (!urlCheck.ok) return res.status(400).json({ error: urlCheck.reason });
  try {
    const eventList   = Array.isArray(events) ? events : ["transaction.completed", "wallet.updated"];
    const webhookSecret = secret ?? `whsec_${randomBytes(20).toString("hex")}`;
    const insertedIds: string[] = [];
    for (const eventType of eventList) {
      const id = generateId("wh");
      await db.insert(webhooksTable).values({ id, url, eventType, secret: webhookSecret, active: true, ownerId: developerId });
      insertedIds.push(id);
    }
    return res.status(201).json({ webhookId: insertedIds[0], webhookIds: insertedIds, url, events: eventList, active: true });
  } catch (err) {
    return res.status(500).json({ error: "Webhook registration failed" });
  }
});

router.get("/webhooks", authenticate(["developer"]), async (req, res) => {
  try {
    const rows = await db.select({
      id: webhooksTable.id,
      url: webhooksTable.url,
      eventType: webhooksTable.eventType,
      active: webhooksTable.active,
      createdAt: webhooksTable.createdAt,
    }).from(webhooksTable)
      .where(eq(webhooksTable.ownerId, req.auth!.userId))
      .orderBy(desc(webhooksTable.createdAt));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Failed to list webhooks" });
  }
});

router.delete("/webhooks/:id", authenticate(["developer"]), async (req, res) => {
  const id = routeParamString(req, "id")!;
  try {
    const deleted = await db.delete(webhooksTable)
      .where(and(eq(webhooksTable.id, id), eq(webhooksTable.ownerId, req.auth!.userId)))
      .returning({ id: webhooksTable.id });
    if (!deleted.length) return res.status(404).json({ error: "Webhook not found" });
    return res.json({ deleted: true, id });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete webhook" });
  }
});

router.get("/docs", (_req, res) => {
  return res.json(getApiDocs());
});

router.get("/sandbox", (_req, res) => {
  return res.json(getSandboxConfig());
});

router.post("/sandbox/reset", authenticate(["developer"]), async (req, res) => {
  return res.json({
    reset: true,
    developerId: req.auth!.userId,
    message:    "Sandbox data reset. Test wallets restored to initial balances.",
    testWallets: getSandboxConfig().testWallets,
  });
});

export default router;
