import { db } from "@workspace/db";
import {
  merchantsTable, walletsTable, transactionsTable,
  productPaymentLinksTable, productInvoicesTable,
  productQrCodesTable, settlementsTable,
} from "@workspace/db";
import { eq, desc, and, or, sql } from "drizzle-orm";
import { generateId } from "./id";
import { randomBytes } from "crypto";

function generateSlug(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function generateInvoiceNumber(): string {
  const now  = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `INV-${yymm}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function getMerchantById(merchantId: string) {
  const rows = await db.select().from(merchantsTable).where(eq(merchantsTable.id, merchantId)).limit(1);
  return rows[0] ?? null;
}

export async function getMerchantPayments(merchantId: string, opts: { limit?: number; offset?: number } = {}) {
  const merchant = await getMerchantById(merchantId);
  if (!merchant) return [];
  const txs = await db.select()
    .from(transactionsTable)
    .where(eq(transactionsTable.toWalletId, merchant.walletId))
    .orderBy(desc(transactionsTable.createdAt))
    .limit(opts.limit ?? 20)
    .offset(opts.offset ?? 0);
  return txs.map(t => ({
    id:        t.id,
    amount:    Number(t.amount),
    currency:  t.currency,
    type:      t.type,
    status:    t.status,
    reference: t.reference,
    from:      t.fromWalletId,
    createdAt: t.createdAt,
  }));
}

export async function getMerchantSettlements(merchantId: string) {
  const merchant = await getMerchantById(merchantId);
  if (!merchant) return [];
  const rows = await db.select()
    .from(settlementsTable)
    .where(eq(settlementsTable.partner, merchantId))
    .orderBy(desc(settlementsTable.createdAt))
    .limit(50);
  return rows;
}

export async function getMerchantStats(merchantId: string) {
  const merchant = await getMerchantById(merchantId);
  if (!merchant) return null;
  const [revenue, txCount] = await Promise.all([
    db.select({ total: sql<string>`coalesce(sum(amount),0)`, cnt: sql<number>`count(*)` })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.toWalletId, merchant.walletId), eq(transactionsTable.status, "completed"))),
    db.select({ cnt: sql<number>`count(*)` })
      .from(transactionsTable)
      .where(eq(transactionsTable.toWalletId, merchant.walletId)),
  ]);
  return {
    merchantId,
    businessName:   merchant.businessName,
    walletId:       merchant.walletId,
    status:         merchant.status,
    totalRevenue:   Number(revenue[0]?.total ?? 0),
    completedCount: Number(revenue[0]?.cnt ?? 0),
    totalTxCount:   Number(txCount[0]?.cnt ?? 0),
  };
}

export async function createPaymentLink(
  merchantId: string,
  opts: {
    title:        string;
    description?: string;
    amount?:      number;
    currency?:    string;
    expiresAt?:   Date;
    metadata?:    Record<string, unknown>;
  }
): Promise<{ id: string; slug: string; url: string }> {
  const id   = generateId("plink");
  const slug = generateSlug("pay");
  await db.insert(productPaymentLinksTable).values({
    id, merchantId, slug,
    title:       opts.title,
    description: opts.description,
    amount:      opts.amount ? String(opts.amount) : undefined,
    currency:    opts.currency ?? "XOF",
    status:      "active",
    expiresAt:   opts.expiresAt,
    metadata:    opts.metadata ?? {},
  });
  return { id, slug, url: `https://pay.kowri.io/l/${slug}` };
}

export async function getPaymentLinks(merchantId: string) {
  return db.select()
    .from(productPaymentLinksTable)
    .where(eq(productPaymentLinksTable.merchantId, merchantId))
    .orderBy(desc(productPaymentLinksTable.createdAt));
}

export async function createInvoice(
  merchantId: string,
  opts: {
    customerName:   string;
    customerEmail?: string;
    customerPhone?: string;
    items:          Array<{ description: string; qty: number; unitPrice: number; total: number }>;
    currency?:      string;
    notes?:         string;
    dueAt?:         Date;
  }
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const invoiceNumber = generateInvoiceNumber();
  const id            = generateId("inv");
  const subtotal      = opts.items.reduce((s, i) => s + i.total, 0);
  const tax           = Math.round(subtotal * 0.18 * 100) / 100;
  const total         = subtotal + tax;

  await db.insert(productInvoicesTable).values({
    id, merchantId,
    invoiceNumber,
    customerName:  opts.customerName,
    customerEmail: opts.customerEmail,
    customerPhone: opts.customerPhone,
    items:         opts.items,
    subtotal:      String(subtotal),
    tax:           String(tax),
    total:         String(total),
    currency:      opts.currency ?? "XOF",
    status:        "draft",
    notes:         opts.notes,
    dueAt:         opts.dueAt,
  });

  return { invoiceId: id, invoiceNumber };
}

export async function getInvoices(merchantId: string) {
  return db.select()
    .from(productInvoicesTable)
    .where(eq(productInvoicesTable.merchantId, merchantId))
    .orderBy(desc(productInvoicesTable.createdAt));
}

export async function sendInvoice(invoiceId: string): Promise<boolean> {
  await db.update(productInvoicesTable)
    .set({ status: "sent", updatedAt: new Date() })
    .where(and(eq(productInvoicesTable.id, invoiceId), eq(productInvoicesTable.status, "draft")));
  return true;
}

export async function generateMerchantQR(
  merchantId: string,
  opts: { amount?: number; currency?: string; label?: string } = {}
): Promise<{ qrId: string; qrData: string; qrUrl: string }> {
  const merchant = await getMerchantById(merchantId);
  if (!merchant) throw new Error("Merchant not found");

  const id      = generateId("mqr");
  const payload = {
    v: 1, t: "merchant_receive",
    mid: merchantId, wid: merchant.walletId,
    a: opts.amount, c: opts.currency ?? "XOF",
    bn: merchant.businessName, qid: id,
  };
  const qrData  = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const qrUrl   = `kowri://pay?qr=${qrData}`;

  await db.insert(productQrCodesTable).values({
    id, entityId: merchantId, entityType: "merchant",
    amount:    opts.amount ? String(opts.amount) : undefined,
    currency:  opts.currency ?? "XOF",
    label:     opts.label ?? merchant.businessName,
    qrData, status: "active",
  });

  return { qrId: id, qrData, qrUrl };
}
