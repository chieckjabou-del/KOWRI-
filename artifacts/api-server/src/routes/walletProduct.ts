import { Router } from "express";
import { consumeVerification } from "../lib/phoneVerification";
import { db } from "@workspace/db";
import { usersTable, walletsTable, kycRecordsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generateId } from "../lib/id";
import { createSession, revokeSession } from "../lib/productAuth";
import { hashPin, verifyPin, isLegacyPinHash, isValidPinFormat } from "../lib/pin";
import { loginRateLimit } from "../lib/loginRateLimit";
import { authenticate, walletBelongsToUser } from "../middleware/auth";
import {
  getWalletSummary, getWalletsByUser, getWalletTransactions,
  generateWalletQR, processQRPayment,
  createNotification, getNotifications, markNotificationRead, markAllRead,
} from "../lib/productWallet";
import { processTransfer } from "../lib/walletService";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { routeParamString } from "../lib/routeParams";

const router = Router();
const walletAuth = authenticate(["wallet"]);

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
    const session = await createSession(user.id, "wallet", { ttlHours: 24, ipAddress: req.ip });
    return res.json({
      token:     session.token,
      expiresAt: session.expiresAt,
      userId:    user.id,
      name:      `${user.firstName} ${user.lastName}`,
    });
  } catch (err) {
    return res.status(500).json({ error: "Login failed" });
  }
});

router.post("/logout", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) await revokeSession(token);
  return res.json({ loggedOut: true });
});

router.post("/create", async (req, res) => {
  const { firstName, lastName, phone, country = "SN", currency = "XOF", pin } = req.body;
  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ error: "firstName, lastName, phone required" });
  }
  if (!isValidPinFormat(pin)) {
    return res.status(400).json({ error: "pin must be 4 to 6 digits" });
  }
  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (existing[0]) return res.status(409).json({ error: "Phone already registered" });
    const gate = await consumeVerification(String(phone), req.body?.verificationToken);
    if (gate) return res.status(gate.status).json({ error: true, code: gate.code, message: gate.message });
    const userId   = generateId("usr");
    const walletId = generateId("wal");
    await db.insert(usersTable).values({
      id: userId, phone, firstName, lastName,
      country, pinHash: hashPin(pin), status: "pending_kyc",
    });
    await db.insert(walletsTable).values({
      id: walletId, userId, currency, walletType: "personal",
    });
    const session = await createSession(userId, "wallet", { ipAddress: req.ip });
    await createNotification(userId, "welcome", "Welcome to KOWRI!", `Hello ${firstName}, your wallet is ready.`, { channel: "in_app" });
    return res.status(201).json({
      userId, walletId, currency,
      token:    session.token,
      message:  "Wallet created successfully",
    });
  } catch (err: any) {
    if (err.code === "23505" || err.message?.includes("unique")) return res.status(409).json({ error: "Phone already registered" });
    return res.status(500).json({ error: "Wallet creation failed" });
  }
});

router.get("/balance", walletAuth, async (req, res) => {
  const { walletId } = req.query;
  if (!walletId) return res.status(400).json({ error: "walletId required" });
  try {
    if (!(await walletBelongsToUser(String(walletId), req.auth!.userId))) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const summary = await getWalletSummary(walletId as string);
    if (!summary) return res.status(404).json({ error: "Wallet not found" });
    return res.json(summary);
  } catch (err) {
    return res.status(500).json({ error: "Balance fetch failed" });
  }
});

router.get("/wallets", walletAuth, async (req, res) => {
  try {
    const wallets = await getWalletsByUser(req.auth!.userId);
    return res.json({ wallets, count: wallets.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch wallets" });
  }
});

router.post("/transfer", walletAuth, requireIdempotencyKey, checkIdempotency, async (req, res) => {
  const { fromWalletId, toWalletId, amount, currency = "XOF", description } = req.body;
  if (!fromWalletId || !toWalletId || !amount) {
    return res.status(400).json({ error: "fromWalletId, toWalletId, amount required" });
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: "amount must be a positive number" });
  }
  try {
    if (!(await walletBelongsToUser(String(fromWalletId), req.auth!.userId))) {
      return res.status(403).json({ error: "You do not own the source wallet" });
    }
    const result = await processTransfer({
      fromWalletId, toWalletId,
      amount: numericAmount, currency,
      description: description ?? "P2P Transfer",
      idempotencyKey: `transfer:${req.auth!.userId}:${req.idempotencyKey}`,
    });
    await createNotification(req.auth!.userId, "transfer_sent", "Transfer Sent",
      `${numericAmount.toLocaleString()} ${currency} sent successfully.`);
    const body = { success: true, ...result };
    await req.saveIdempotentResponse?.(body);
    return res.status(201).json(body);
  } catch (err: any) {
    if (err.message?.includes("Insufficient")) return res.status(422).json({ error: "Insufficient balance" });
    if (err.name === "CurrencyMismatchError" || err.name === "InvalidAmountError" || err.name === "WalletUnavailableError") return res.status(400).json({ error: err.message });
    if (err.name === "TransactionBlockedError") return res.status(403).json({ error: "Transaction blocked by risk screening", code: "TRANSACTION_BLOCKED", reasons: err.findings?.filter((f: any) => f.blocking).map((f: any) => f.type) });
    return res.status(500).json({ error: "Transfer failed" });
  }
});

router.get("/transactions", walletAuth, async (req, res) => {
  const { walletId, limit, offset } = req.query;
  if (!walletId) return res.status(400).json({ error: "walletId required" });
  try {
    if (!(await walletBelongsToUser(String(walletId), req.auth!.userId))) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const txs = await getWalletTransactions(walletId as string, {
      limit:  Number(limit  ?? 20),
      offset: Number(offset ?? 0),
    });
    return res.json({ transactions: txs, count: txs.length, walletId });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

router.post("/qr/generate", walletAuth, async (req, res) => {
  const { walletId, amount, currency, label, ttlMins } = req.body;
  if (!walletId) return res.status(400).json({ error: "walletId required" });
  try {
    if (!(await walletBelongsToUser(String(walletId), req.auth!.userId))) {
      return res.status(403).json({ error: "You do not own this wallet" });
    }
    const result = await generateWalletQR(walletId, { amount, currency, label, ttlMins });
    return res.status(201).json(result);
  } catch (err) {
    return res.status(500).json({ error: "QR generation failed" });
  }
});

router.post("/qr/pay", walletAuth, requireIdempotencyKey, checkIdempotency, async (req, res) => {
  const { qrData, fromWalletId } = req.body;
  if (!qrData || !fromWalletId) return res.status(400).json({ error: "qrData and fromWalletId required" });
  try {
    if (!(await walletBelongsToUser(String(fromWalletId), req.auth!.userId))) {
      return res.status(403).json({ error: "You do not own the source wallet" });
    }
    const result = await processQRPayment(qrData, fromWalletId);
    if (!result.success) return res.status(400).json({ error: result.message });
    await req.saveIdempotentResponse?.(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: "QR payment failed" });
  }
});

// Submission only creates a pending KYC record; kycLevel is raised by the compliance review flow.
router.post("/verify/identity", walletAuth, async (req, res) => {
  const { documentType, documentNumber, fullName, dateOfBirth } = req.body;
  if (!documentType || !documentNumber) {
    return res.status(400).json({ error: "documentType, documentNumber required" });
  }
  const validTypes = ["national_id", "passport", "drivers_license"];
  if (!validTypes.includes(documentType)) {
    return res.status(400).json({ error: `documentType must be one of: ${validTypes.join(", ")}` });
  }
  const userId = req.auth!.userId;
  try {
    const [record] = await db.insert(kycRecordsTable).values({
      id:             generateId(),
      userId,
      kycLevel:       1,
      documentType:   documentType as any,
      documentNumber: String(documentNumber),
      fullName:       fullName ? String(fullName) : null,
      dateOfBirth:    dateOfBirth ? String(dateOfBirth) : null,
      status:         "pending",
    }).returning();
    await createNotification(userId, "kyc_submitted", "Identity Verification Submitted",
      "Your identity verification is under review.", { channel: "in_app" });
    return res.json({ submitted: true, userId, recordId: record.id, documentType, status: "pending", estimatedReviewTime: "1-2 business days" });
  } catch (err) {
    return res.status(500).json({ error: "Identity verification submission failed" });
  }
});

router.get("/notifications", walletAuth, async (req, res) => {
  const { unreadOnly, limit } = req.query;
  try {
    const notifs = await getNotifications(req.auth!.userId, {
      unreadOnly: unreadOnly === "true",
      limit:      Number(limit ?? 20),
    });
    return res.json({ notifications: notifs, count: notifs.length, userId: req.auth!.userId });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.post("/notifications/:id/read", walletAuth, async (req, res) => {
  const notificationId = routeParamString(req, "id")!;
  try {
    await markNotificationRead(notificationId, req.auth!.userId);
    return res.json({ read: true, notificationId });
  } catch (err) {
    return res.status(500).json({ error: "Failed to mark notification" });
  }
});

router.post("/notifications/read-all", walletAuth, async (req, res) => {
  try {
    await markAllRead(req.auth!.userId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to mark all read" });
  }
});

export default router;
