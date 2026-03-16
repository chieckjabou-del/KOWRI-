import { db } from "@workspace/db";
import {
  usersTable, walletsTable, transactionsTable,
  productQrCodesTable, productNotificationsTable,
} from "@workspace/db";
import { eq, desc, and, or, sql } from "drizzle-orm";
import { generateId } from "./id";
import { getWalletBalance } from "./walletService";

export interface WalletSummary {
  walletId:   string;
  userId:     string;
  currency:   string;
  balance:    number;
  available:  number;
  status:     string;
  walletType: string;
}

export async function getWalletSummary(walletId: string): Promise<WalletSummary | null> {
  const rows = await db.select().from(walletsTable).where(eq(walletsTable.id, walletId)).limit(1);
  if (!rows[0]) return null;
  const w = rows[0];
  const live = await getWalletBalance(walletId);
  return {
    walletId:   w.id,
    userId:     w.userId,
    currency:   w.currency,
    balance:    live,
    available:  live,
    status:     w.status,
    walletType: w.walletType,
  };
}

export async function getWalletsByUser(userId: string): Promise<WalletSummary[]> {
  const rows = await db.select().from(walletsTable).where(eq(walletsTable.userId, userId));
  return Promise.all(rows.map(async w => {
    const bal = await getWalletBalance(w.id);
    return { walletId: w.id, userId: w.userId, currency: w.currency, balance: bal, available: bal, status: w.status, walletType: w.walletType };
  }));
}

export async function getWalletTransactions(
  walletId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const limit  = opts.limit  ?? 20;
  const offset = opts.offset ?? 0;

  const txs = await db.select()
    .from(transactionsTable)
    .where(or(
      eq(transactionsTable.fromWalletId, walletId),
      eq(transactionsTable.toWalletId,   walletId),
    ))
    .orderBy(desc(transactionsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return txs.map(t => ({
    id:          t.id,
    type:        t.type,
    direction:   t.fromWalletId === walletId ? "debit" : "credit",
    amount:      Number(t.amount),
    currency:    t.currency,
    status:      t.status,
    reference:   t.reference,
    description: t.description,
    createdAt:   t.createdAt,
  }));
}

export async function generateWalletQR(
  walletId: string,
  opts: { amount?: number; currency?: string; label?: string; ttlMins?: number } = {}
): Promise<{ qrId: string; qrData: string; qrUrl: string }> {
  const id      = generateId("qr");
  const payload = {
    v:  1,
    t:  "wallet_receive",
    id: walletId,
    a:  opts.amount,
    c:  opts.currency ?? "XOF",
    l:  opts.label,
    qid: id,
  };
  const qrData  = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const qrUrl   = `kowri://pay?qr=${qrData}`;
  const exp     = opts.ttlMins ? new Date(Date.now() + opts.ttlMins * 60_000) : undefined;

  await db.insert(productQrCodesTable).values({
    id, entityId: walletId, entityType: "wallet",
    amount:    opts.amount ? String(opts.amount) : undefined,
    currency:  opts.currency ?? "XOF",
    label:     opts.label,
    qrData, status: "active",
    expiresAt: exp,
  });

  return { qrId: id, qrData, qrUrl };
}

export async function processQRPayment(
  qrData: string,
  fromWalletId: string
): Promise<{ success: boolean; toWalletId?: string; amount?: number; message?: string }> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(qrData, "base64url").toString("utf8"));
  } catch {
    return { success: false, message: "Invalid QR code" };
  }
  const qrId      = payload.qid as string;
  const toWallet  = payload.id as string;
  const amount    = payload.a as number;

  if (!toWallet) return { success: false, message: "Invalid QR: missing destination" };
  if (!amount)   return { success: false, message: "This QR requires you to enter an amount" };

  const qrRows = await db.select().from(productQrCodesTable).where(eq(productQrCodesTable.id, qrId)).limit(1);
  const qr     = qrRows[0];
  if (qr) {
    if (qr.status !== "active") return { success: false, message: "QR code expired or already used" };
    if (qr.expiresAt && qr.expiresAt < new Date()) return { success: false, message: "QR code expired" };
    if (qr.maxUses && qr.useCount >= qr.maxUses) return { success: false, message: "QR code usage limit reached" };
    await db.update(productQrCodesTable)
      .set({ useCount: sql`${productQrCodesTable.useCount} + 1` })
      .where(eq(productQrCodesTable.id, qrId));
  }

  return { success: true, toWalletId: toWallet, amount, message: "QR payment ready — call /wallet/transfer to complete" };
}

export async function createNotification(
  userId: string,
  type: string,
  title: string,
  message: string,
  opts: { channel?: string; metadata?: Record<string, unknown> } = {}
): Promise<string> {
  const id = generateId("notif");
  await db.insert(productNotificationsTable).values({
    id, userId, type, title, message,
    channel:  opts.channel  ?? "in_app",
    metadata: opts.metadata ?? {},
    read:     false,
  });
  return id;
}

export async function getNotifications(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const rows = await db.select()
    .from(productNotificationsTable)
    .where(and(
      eq(productNotificationsTable.userId, userId),
      opts.unreadOnly ? eq(productNotificationsTable.read, false) : undefined,
    ))
    .orderBy(desc(productNotificationsTable.createdAt))
    .limit(opts.limit ?? 20);
  return rows;
}

export async function markNotificationRead(notifId: string, userId: string): Promise<boolean> {
  const result = await db.update(productNotificationsTable)
    .set({ read: true })
    .where(and(
      eq(productNotificationsTable.id, notifId),
      eq(productNotificationsTable.userId, userId),
    ));
  return true;
}

export async function markAllRead(userId: string): Promise<void> {
  await db.update(productNotificationsTable)
    .set({ read: true })
    .where(eq(productNotificationsTable.userId, userId));
}
