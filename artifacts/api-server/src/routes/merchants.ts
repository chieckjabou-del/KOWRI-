import { Router } from "express";
import { db } from "@workspace/db";
import { merchantsTable, walletsTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { generateId, generateApiKey } from "../lib/id";
import { requireAuth } from "../lib/productAuth";

const router = Router();

router.use(async (req, res, next) => {
  const auth = await requireAuth(req.headers.authorization);
  if (!auth) {
    res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
    return;
  }
  next();
});

router.get("/", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const where = status ? eq(merchantsTable.status, status as any) : undefined;

    const [merchants, [{ total }]] = await Promise.all([
      db.select().from(merchantsTable).where(where).limit(limit).offset(offset).orderBy(sql`${merchantsTable.createdAt} DESC`),
      db.select({ total: count() }).from(merchantsTable).where(where),
    ]);

    res.json({
      merchants: merchants.map(m => ({
        ...m,
        totalRevenue: Number(m.totalRevenue),
        apiKey: m.apiKey ? `${m.apiKey.slice(0, 12)}...` : null,
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const { userId, businessName, businessType, country } = req.body;
    if (!userId || !businessName || !businessType || !country) {
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

    res.status(201).json({ ...merchant, totalRevenue: Number(merchant.totalRevenue) });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

export default router;
