import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, walletsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generateId } from "../lib/id";
import { createSession, requireAuth, revokeSession } from "../lib/productAuth";
import {
  getWalletSummary, getWalletsByUser, getWalletTransactions,
  generateWalletQR, processQRPayment,
  createNotification, getNotifications, markNotificationRead, markAllRead,
} from "../lib/productWallet";
import { processTransfer, processDeposit } from "../lib/walletService";

const router = Router();

router.post("/login", async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ error: "phone and pin required" });
  try {
    const users = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (!users[0]) return res.status(401).json({ error: "User not found" });
    const session = await createSession(users[0].id, "wallet", { ttlHours: 24 });
    res.json({
      token:     session.token,
      expiresAt: session.expiresAt,
      userId:    users[0].id,
      name:      `${users[0].firstName} ${users[0].lastName}`,
    });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

router.post("/logout", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) await revokeSession(token);
  res.json({ loggedOut: true });
});

router.post("/create", async (req, res) => {
  const { firstName, lastName, phone, country = "SN", currency = "XOF", pin = "000000" } = req.body;
  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ error: "firstName, lastName, phone required" });
  }
  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (existing[0]) return res.status(409).json({ error: "Phone already registered" });
    const userId   = generateId("usr");
    const walletId = generateId("wal");
    await db.insert(usersTable).values({
      id: userId, phone, firstName, lastName,
      country, pinHash: pin, status: "pending_kyc",
    });
    await db.insert(walletsTable).values({
      id: walletId, userId, currency, walletType: "personal",
    });
    const session = await createSession(userId, "wallet");
    await createNotification(userId, "welcome", "Welcome to KOWRI!", `Hello ${firstName}, your wallet is ready.`, { channel: "in_app" });
    res.status(201).json({
      userId, walletId, currency,
      token:    session.token,
      message:  "Wallet created successfully",
    });
  } catch (err: any) {
    if (err.code === "23505" || err.message?.includes("unique")) return res.status(409).json({ error: "Phone already registered" });
    res.status(500).json({ error: "Wallet creation failed" });
  }
});

router.get("/balance", async (req, res) => {
  const { walletId } = req.query;
  if (!walletId) return res.status(400).json({ error: "walletId required" });
  try {
    const summary = await getWalletSummary(walletId as string);
    if (!summary) return res.status(404).json({ error: "Wallet not found" });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: "Balance fetch failed" });
  }
});

router.get("/wallets", async (req, res) => {
  const auth = await requireAuth(req.headers.authorization, ["wallet"]);
  if (!auth) return res.status(401).json({ error: "Authentication required" });
  try {
    const wallets = await getWalletsByUser(auth.userId);
    res.json({ wallets, count: wallets.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch wallets" });
  }
});

router.post("/transfer", async (req, res) => {
  const { fromWalletId, toWalletId, amount, currency = "XOF", description, idempotencyKey } = req.body;
  if (!fromWalletId || !toWalletId || !amount) {
    return res.status(400).json({ error: "fromWalletId, toWalletId, amount required" });
  }
  try {
    const idemKey = idempotencyKey ?? `wallet-transfer-${Date.now()}-${Math.random()}`;
    const result  = await processTransfer({
      fromWalletId, toWalletId,
      amount: Number(amount), currency,
      description: description ?? "P2P Transfer",
      idempotencyKey: idemKey,
    });
    await createNotification(fromWalletId, "transfer_sent", "Transfer Sent",
      `${Number(amount).toLocaleString()} ${currency} sent successfully.`);
    res.status(201).json({ success: true, ...result });
  } catch (err: any) {
    if (err.message?.includes("Insufficient")) return res.status(422).json({ error: "Insufficient balance" });
    res.status(500).json({ error: "Transfer failed" });
  }
});

router.get("/transactions", async (req, res) => {
  const { walletId, limit, offset } = req.query;
  if (!walletId) return res.status(400).json({ error: "walletId required" });
  try {
    const txs = await getWalletTransactions(walletId as string, {
      limit:  Number(limit  ?? 20),
      offset: Number(offset ?? 0),
    });
    res.json({ transactions: txs, count: txs.length, walletId });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

router.post("/qr/generate", async (req, res) => {
  const { walletId, amount, currency, label, ttlMins } = req.body;
  if (!walletId) return res.status(400).json({ error: "walletId required" });
  try {
    const result = await generateWalletQR(walletId, { amount, currency, label, ttlMins });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: "QR generation failed" });
  }
});

router.post("/qr/pay", async (req, res) => {
  const { qrData, fromWalletId } = req.body;
  if (!qrData || !fromWalletId) return res.status(400).json({ error: "qrData and fromWalletId required" });
  try {
    const result = await processQRPayment(qrData, fromWalletId);
    if (!result.success) return res.status(400).json({ error: result.message });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "QR payment failed" });
  }
});

router.post("/verify/identity", async (req, res) => {
  const { userId, documentType, documentNumber } = req.body;
  if (!userId || !documentType || !documentNumber) {
    return res.status(400).json({ error: "userId, documentType, documentNumber required" });
  }
  const validTypes = ["national_id", "passport", "drivers_license"];
  if (!validTypes.includes(documentType)) {
    return res.status(400).json({ error: `documentType must be one of: ${validTypes.join(", ")}` });
  }
  try {
    await db.update(usersTable)
      .set({ kycLevel: 1, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));
    await createNotification(userId, "kyc_submitted", "Identity Verification Submitted",
      "Your identity verification is under review.", { channel: "in_app" });
    res.json({ submitted: true, userId, documentType, status: "pending", estimatedReviewTime: "1-2 business days" });
  } catch (err) {
    res.status(500).json({ error: "Identity verification submission failed" });
  }
});

router.get("/notifications", async (req, res) => {
  const auth = await requireAuth(req.headers.authorization, ["wallet"]);
  if (!auth) return res.status(401).json({ error: "Authentication required" });
  const { unreadOnly, limit } = req.query;
  try {
    const notifs = await getNotifications(auth.userId, {
      unreadOnly: unreadOnly === "true",
      limit:      Number(limit ?? 20),
    });
    res.json({ notifications: notifs, count: notifs.length, userId: auth.userId });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.post("/notifications/:id/read", async (req, res) => {
  const auth = await requireAuth(req.headers.authorization, ["wallet"]);
  if (!auth) return res.status(401).json({ error: "Authentication required" });
  try {
    await markNotificationRead(req.params.id, auth.userId);
    res.json({ read: true, notificationId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark notification" });
  }
});

router.post("/notifications/read-all", async (req, res) => {
  const auth = await requireAuth(req.headers.authorization, ["wallet"]);
  if (!auth) return res.status(401).json({ error: "Authentication required" });
  try {
    await markAllRead(auth.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark all read" });
  }
});

export default router;
