import { Router } from "express";
import { db } from "@workspace/db";
import { merchantsTable, walletsTable } from "@workspace/db";
import { eq, and, sql, count } from "drizzle-orm";
import { generateId, generateApiKey } from "../lib/id";
import { authenticate, isAdminRequest } from "../middleware/auth";
import { validateQueryParams, VALID_MERCHANT_STATUSES } from "../middleware/validate";

const router = Router();

router.use(authenticate());

// Admins see every merchant; a user only sees the merchant accounts they own.
router.get("/", validateQueryParams({ status: VALID_MERCHANT_STATUSES }), async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;
    const admin = isAdminRequest(req);

    const conditions = [];
    if (status) conditions.push(eq(merchantsTable.status, status as any));
    if (!admin) conditions.push(eq(merchantsTable.userId, req.auth!.userId));
    const where = conditions.length ? and(...conditions) : undefined;

    const [merchants, [{ total }]] = await Promise.all([
      db.select().from(merchantsTable).where(where).limit(limit).offset(offset).orderBy(sql`${merchantsTable.createdAt} DESC`),
      db.select({ total: count() }).from(merchantsTable).where(where),
    ]);

    return res.json({
      merchants: merchants.map(m => ({
        ...m,
        totalRevenue: Number(m.totalRevenue),
        apiKey: admin || m.userId === req.auth!.userId ? (m.apiKey ? `${m.apiKey.slice(0, 12)}...` : null) : null,
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { businessName, businessType, country } = req.body;
    const userId = req.auth!.userId;
    if (!businessName || !businessType || !country) {
      return res.status(400).json({ error: "Bad request", message: "Missing required fields" });
    }

    const walletId = generateId();
    await db.insert(walletsTable).values({
      id: walletId,
      userId,
      currency: "XOF",
      balance: "0",
      availableBalance: "0",
      status: "active",
      walletType: "merchant",
    });

    const [merchant] = await db.insert(merchantsTable).values({
      id: generateId(),
      userId,
      businessName,
      businessType,
      status: "pending_approval",
      walletId,
      apiKey: generateApiKey(),
      country,
      totalRevenue: "0",
      transactionCount: 0,
    }).returning();

    return res.status(201).json({ ...merchant, totalRevenue: Number(merchant.totalRevenue) });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
