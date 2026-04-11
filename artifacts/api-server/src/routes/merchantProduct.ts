import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, walletsTable, merchantsTable, webhooksTable, tontineStrategyTargetsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { generateId } from "../lib/id";
import { createSession, requireAuth } from "../lib/productAuth";
import {
  getMerchantById, getMerchantPayments, getMerchantSettlements, getMerchantStats,
  createPaymentLink, getPaymentLinks, createInvoice, getInvoices, sendInvoice,
  generateMerchantQR,
} from "../lib/productMerchant";
import { randomBytes } from "crypto";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { routeParamString } from "../lib/routeParams";
import { hashPin, isValidPin, normalizePhone, verifyPin } from "../lib/password";

const router = Router();

router.post("/login", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const pin = String(req.body?.pin ?? "");
  if (!phone || !pin) return res.status(400).json({ error: "phone and pin required" });
  if (!isValidPin(pin)) return res.status(400).json({ error: "pin must be exactly 4 digits" });
  try {
    const users = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (!users[0]) return res.status(401).json({ error: "User not found" });
    const ok = await verifyPin(pin, (users[0] as any).pinHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const merchants = await db.select().from(merchantsTable).where(eq(merchantsTable.userId, users[0].id)).limit(1);
    if (!merchants[0]) return res.status(403).json({ error: "No merchant account found for this user" });
    const session = await createSession(users[0].id, "merchant", { ttlHours: 48 });
    return res.json({ token: session.token, expiresAt: session.expiresAt, merchantId: merchants[0].id, businessName: merchants[0].businessName });
  } catch (err) {
    return res.status(500).json({ error: "Merchant login failed" });
  }
});

router.post("/create", async (req, res) => {
  const { businessName, businessType, country = "SN", phone, firstName, lastName, pin = "0000" } = req.body;
  const normalizedPhone = normalizePhone(phone);
  const pinStr = String(pin ?? "");
  if (!businessName || !businessType || !phone || !firstName || !lastName) {
    return res.status(400).json({ error: "businessName, businessType, phone, firstName, lastName required" });
  }
  if (!isValidPin(pinStr)) return res.status(400).json({ error: "pin must be exactly 4 digits" });
  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, normalizedPhone)).limit(1);
    if (existing[0]) return res.status(409).json({ error: "Phone already registered" });
    const userId     = generateId("usr");
    const walletId   = generateId("wal");
    const merchantId = generateId("mch");
    const apiKey     = `kwk_${randomBytes(20).toString("hex")}`;

    const pinHash = await hashPin(pinStr);
    await db.insert(usersTable).values({
      id: userId, phone: normalizedPhone, firstName, lastName, country, pinHash, status: "pending_kyc",
    });
    await db.insert(walletsTable).values({
      id: walletId, userId, currency: "XOF", walletType: "merchant",
    });
    await db.insert(merchantsTable).values({
      id: merchantId, userId, businessName, businessType, walletId, country,
      status: "pending_approval", apiKey,
    });
    const session = await createSession(userId, "merchant", { ttlHours: 48 });
    return res.status(201).json({
      merchantId, userId, walletId, businessName,
      apiKey, status: "pending_approval",
      token: session.token,
    });
  } catch (err: any) {
    if (err.code === "23505" || err.message?.includes("unique")) return res.status(409).json({ error: "Phone already registered" });
    return res.status(500).json({ error: "Merchant creation failed" });
  }
});

router.get("/profile", async (req, res) => {
  const auth = await requireAuth(req.headers.authorization, ["merchant"]);
  if (!auth) return res.status(401).json({ error: "Authentication required" });
  try {
    const merchants = await db.select().from(merchantsTable).where(eq(merchantsTable.userId, auth.userId)).limit(1);
    if (!merchants[0]) return res.status(404).json({ error: "Merchant not found" });
    return res.json(merchants[0]);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch merchant profile" });
  }
});

router.post("/payment", requireIdempotencyKey, checkIdempotency, async (req, res) => {
  const { merchantId, fromWalletId, amount, currency = "XOF", description, reference } = req.body;
  if (!merchantId || !fromWalletId || !amount) {
    return res.status(400).json({ error: "merchantId, fromWalletId, amount required" });
  }
  try {
    const merchant = await getMerchantById(merchantId);
    if (!merchant) return res.status(404).json({ error: "Merchant not found" });
    if (merchant.status !== "active") return res.status(403).json({ error: "Merchant not active" });

    const ref = reference ?? `MRX-${Date.now()}-${randomBytes(4).toString("hex").toUpperCase()}`;
    const txId = generateId("tx");
    return res.status(201).json({
      paymentId:      txId,
      merchantId,
      fromWalletId,
      toWalletId:     merchant.walletId,
      amount:         Number(amount),
      currency,
      status:         "pending",
      reference:      ref,
      description:    description ?? `Payment to ${merchant.businessName}`,
      instructions:   "Call POST /wallets/:id/transfer with the provided toWalletId and reference to complete payment",
      toWalletId_use: merchant.walletId,
    });
  } catch (err) {
    return res.status(500).json({ error: "Payment initiation failed" });
  }
});

router.get("/payments", async (req, res) => {
  const { merchantId, limit, offset } = req.query;
  if (!merchantId) return res.status(400).json({ error: "merchantId required" });
  try {
    const payments = await getMerchantPayments(merchantId as string, {
      limit:  Number(limit  ?? 20),
      offset: Number(offset ?? 0),
    });
    return res.json({ payments, count: payments.length, merchantId });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch payments" });
  }
});

router.get("/settlements", async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: "merchantId required" });
  try {
    const settlements = await getMerchantSettlements(merchantId as string);
    return res.json({ settlements, count: settlements.length, merchantId });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch settlements" });
  }
});

router.get("/stats", async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: "merchantId required" });
  try {
    const stats = await getMerchantStats(merchantId as string);
    if (!stats) return res.status(404).json({ error: "Merchant not found" });
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch stats" });
  }
});

router.post("/payment-link", async (req, res) => {
  const { merchantId, title, description, amount, currency, expiresAt } = req.body;
  if (!merchantId || !title) return res.status(400).json({ error: "merchantId and title required" });
  try {
    const result = await createPaymentLink(merchantId, {
      title, description, amount, currency,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });
    return res.status(201).json(result);
  } catch (err) {
    return res.status(500).json({ error: "Failed to create payment link" });
  }
});

router.get("/payment-links", async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: "merchantId required" });
  try {
    const links = await getPaymentLinks(merchantId as string);
    return res.json({ links, count: links.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch payment links" });
  }
});

router.post("/invoice", async (req, res) => {
  const { merchantId, customerName, customerEmail, customerPhone, items, currency, notes, dueAt } = req.body;
  if (!merchantId || !customerName || !items?.length) {
    return res.status(400).json({ error: "merchantId, customerName, items required" });
  }
  try {
    const result = await createInvoice(merchantId, {
      customerName, customerEmail, customerPhone,
      items, currency, notes,
      dueAt: dueAt ? new Date(dueAt) : undefined,
    });
    return res.status(201).json(result);
  } catch (err) {
    return res.status(500).json({ error: "Invoice creation failed" });
  }
});

router.get("/invoices", async (req, res) => {
  const { merchantId } = req.query;
  if (!merchantId) return res.status(400).json({ error: "merchantId required" });
  try {
    const invoices = await getInvoices(merchantId as string);
    return res.json({ invoices, count: invoices.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch invoices" });
  }
});

router.post("/invoices/:invoiceId/send", async (req, res) => {
  try {
    await sendInvoice(req.params.invoiceId);
    return res.json({ sent: true, invoiceId: req.params.invoiceId });
  } catch (err) {
    return res.status(500).json({ error: "Failed to send invoice" });
  }
});

router.post("/qr/generate", async (req, res) => {
  const { merchantId, amount, currency, label } = req.body;
  if (!merchantId) return res.status(400).json({ error: "merchantId required" });
  try {
    const result = await generateMerchantQR(merchantId, { amount, currency, label });
    return res.status(201).json(result);
  } catch (err: any) {
    if (err.message === "Merchant not found") return res.status(404).json({ error: "Merchant not found" });
    return res.status(500).json({ error: "QR generation failed" });
  }
});

// ── Strategy performance tracking ───────────────────────────────────────────
// POST /api/merchants/:id/payment — record a completed sale and update
// any linked tontine strategy target performance scores.
router.post("/:merchantId/payment", requireIdempotencyKey, checkIdempotency, async (req, res) => {
  const merchantId = routeParamString(req, "merchantId")!;
  const { amount, description, reference } = req.body;
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount required and must be > 0" });
  }
  try {
    const merchant = await getMerchantById(merchantId);
    if (!merchant) return res.status(404).json({ error: "Merchant not found" });
    if (merchant.status !== "active") return res.status(403).json({ error: "Merchant not active" });

    const saleAmount = Number(amount);

    // 1. Update merchant total revenue
    await db.update(merchantsTable)
      .set({ totalRevenue: sql`${merchantsTable.totalRevenue}::numeric + ${saleAmount}` })
      .where(eq(merchantsTable.id, merchantId));

    // 2. Find all active/funded strategy targets for this merchant
    const targets = await db.select().from(tontineStrategyTargetsTable)
      .where(eq(tontineStrategyTargetsTable.merchantId, merchantId));

    const updatedTargets: Array<{ targetId: string; revenueGenerated: number; performanceScore: number }> = [];

    for (const target of targets) {
      if (target.status === "completed" || target.status === "defaulted") continue;
      const newRevenue      = Number(target.revenueGenerated) + saleAmount;
      const allocated       = Number(target.allocatedAmount);
      const performanceScore = allocated > 0 ? (newRevenue / allocated) * 100 : 0;

      await db.update(tontineStrategyTargetsTable).set({
        revenueGenerated: String(newRevenue.toFixed(4)),
        performanceScore: String(Math.min(9999.99, performanceScore).toFixed(2)),
      }).where(eq(tontineStrategyTargetsTable.id, target.id));

      updatedTargets.push({ targetId: target.id, revenueGenerated: newRevenue, performanceScore });
    }

    return res.status(201).json({
      success:        true,
      merchantId,
      saleAmount,
      description:    description ?? `Sale for ${merchant.businessName}`,
      reference:      reference ?? `SALE-${Date.now()}`,
      updatedTargets,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to record payment" });
  }
});

router.get("/webhooks", async (req, res) => {
  const auth = await requireAuth(req.headers.authorization, ["merchant"]);
  if (!auth) return res.status(401).json({ error: "Authentication required" });
  try {
    // webhooks rows are not scoped to users/merchants in schema — cannot filter by merchant
    const webhooks: (typeof webhooksTable.$inferSelect)[] = [];
    return res.json({ webhooks, count: 0 });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch webhooks" });
  }
});

export default router;
