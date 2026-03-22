import { Router } from "express";
import { db } from "@workspace/db";
import { tontinesTable, tontineMembersTable, usersTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { generateId } from "../lib/id";
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

const VALID_TONTINE_STATUSES = new Set(["pending", "active", "completed", "cancelled"]);

router.get("/", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    if (status && !VALID_TONTINE_STATUSES.has(status)) {
      res.status(400).json({ error: true, message: `Invalid status. Must be one of: ${[...VALID_TONTINE_STATUSES].join(", ")}` });
      return;
    }

    const where = status ? eq(tontinesTable.status, status as any) : undefined;

    const [tontines, [{ total }]] = await Promise.all([
      db.select().from(tontinesTable).where(where).limit(limit).offset(offset).orderBy(sql`${tontinesTable.createdAt} DESC`),
      db.select({ total: count() }).from(tontinesTable).where(where),
    ]);

    res.json({
      tontines: tontines.map((t) => ({ ...t, contributionAmount: Number(t.contributionAmount) })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, description, contributionAmount, currency, frequency, maxMembers, adminUserId } = req.body;
    if (!name || !contributionAmount || !currency || !frequency || !maxMembers || !adminUserId) {
      res.status(400).json({ error: true, message: "Missing required fields: name, contributionAmount, currency, frequency, maxMembers, adminUserId" });
      return;
    }

    const [tontine] = await db.insert(tontinesTable).values({
      id: generateId(),
      name,
      description: description || null,
      contributionAmount: String(contributionAmount),
      currency,
      frequency,
      maxMembers: Number(maxMembers),
      memberCount: 1,
      currentRound: 0,
      totalRounds: Number(maxMembers),
      status: "pending",
      adminUserId,
    }).returning();

    await db.insert(tontineMembersTable).values({
      id: generateId(),
      tontineId: tontine.id,
      userId: adminUserId,
      payoutOrder: 1,
      hasReceivedPayout: 0,
      contributionsCount: 0,
    });

    res.status(201).json({ ...tontine, contributionAmount: Number(tontine.contributionAmount) });
  } catch (err) {
    next(err);
  }
});

router.get("/:tontineId", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) {
      res.status(404).json({ error: true, message: "Tontine not found" });
      return;
    }

    const members = await db
      .select({
        userId: tontineMembersTable.userId,
        payoutOrder: tontineMembersTable.payoutOrder,
        hasReceivedPayout: tontineMembersTable.hasReceivedPayout,
        contributionsCount: tontineMembersTable.contributionsCount,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
      })
      .from(tontineMembersTable)
      .leftJoin(usersTable, eq(tontineMembersTable.userId, usersTable.id))
      .where(eq(tontineMembersTable.tontineId, tontineId))
      .orderBy(tontineMembersTable.payoutOrder);

    const totalContributed = members.reduce(
      (sum, m) => sum + m.contributionsCount * Number(tontine.contributionAmount), 0
    );

    res.json({
      ...tontine,
      contributionAmount: Number(tontine.contributionAmount),
      members: members.map((m) => ({
        userId: m.userId,
        userName: `${m.firstName} ${m.lastName}`,
        payoutOrder: m.payoutOrder,
        hasReceivedPayout: m.hasReceivedPayout === 1,
        contributionsCount: m.contributionsCount,
      })),
      totalContributed,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
