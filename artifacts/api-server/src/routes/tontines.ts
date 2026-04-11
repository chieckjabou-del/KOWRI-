import { Router } from "express";
import { db } from "@workspace/db";
import { tontinesTable, tontineMembersTable, usersTable } from "@workspace/db";
import { eq, sql, count, and, or, inArray } from "drizzle-orm";
import { generateId } from "../lib/id";
import { requireAuth } from "../lib/productAuth";

const router = Router();

const VALID_TONTINE_STATUSES = new Set(["pending", "active", "completed", "cancelled"]);
const VALID_TONTINE_TYPES    = new Set(["classic", "investment", "project", "solidarity", "business", "diaspora", "yield", "growth"]);

// ── Public discovery — no auth required ────────────────────────────────────────
router.get("/public", async (req, res, next) => {
  try {
    const page      = Number(req.query.page)   || 1;
    const limit     = Math.min(Number(req.query.limit) || 20, 100);
    const offset    = (page - 1) * limit;
    const type      = req.query.type      as string | undefined;
    const currency  = req.query.currency  as string | undefined;
    const frequency = req.query.frequency as string | undefined;

    const conditions = [
      eq(tontinesTable.isPublic, true),
      or(
        eq(tontinesTable.status, "active"),
        eq(tontinesTable.status, "pending"),
      )!,
    ];

    if (type) {
      if (!VALID_TONTINE_TYPES.has(type)) {
        return res.status(400).json({ error: true, message: `Invalid type. Must be one of: ${[...VALID_TONTINE_TYPES].join(", ")}` });
      }
      conditions.push(eq(tontinesTable.tontineType, type as any));
    }
    if (currency)  conditions.push(eq(tontinesTable.currency,  currency));
    if (frequency) conditions.push(eq(tontinesTable.frequency, frequency as any));

    const where = and(...conditions);

    const [tontines, [{ total }]] = await Promise.all([
      db.select({
        id:                 tontinesTable.id,
        name:               tontinesTable.name,
        description:        tontinesTable.description,
        contributionAmount: tontinesTable.contributionAmount,
        currency:           tontinesTable.currency,
        frequency:          tontinesTable.frequency,
        maxMembers:         tontinesTable.maxMembers,
        memberCount:        tontinesTable.memberCount,
        currentRound:       tontinesTable.currentRound,
        totalRounds:        tontinesTable.totalRounds,
        status:             tontinesTable.status,
        tontineType:        tontinesTable.tontineType,
        isMultiAmount:      tontinesTable.isMultiAmount,
        goalDescription:    tontinesTable.goalDescription,
        goalAmount:         tontinesTable.goalAmount,
        currencyMode:       tontinesTable.currencyMode,
        nextPayoutDate:     tontinesTable.nextPayoutDate,
        createdAt:          tontinesTable.createdAt,
      })
        .from(tontinesTable)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(sql`${tontinesTable.createdAt} DESC`),
      db.select({ total: count() }).from(tontinesTable).where(where),
    ]);

    return res.json({
      tontines: tontines.map(t => ({
        ...t,
        contributionAmount: Number(t.contributionAmount),
        goalAmount: t.goalAmount ? Number(t.goalAmount) : null,
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) { return next(err); }
});

// ── All routes below require auth ──────────────────────────────────────────────
router.use(async (req, res, next) => {
  const auth = await requireAuth(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
  }
  return next();
});

router.get("/", async (req, res, next) => {
  try {
    const page   = Number(req.query.page)  || 1;
    const limit  = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    if (status && !VALID_TONTINE_STATUSES.has(status)) {
      return res.status(400).json({ error: true, message: `Invalid status. Must be one of: ${[...VALID_TONTINE_STATUSES].join(", ")}` });
    }

    const where = status ? eq(tontinesTable.status, status as any) : undefined;

    const [tontines, [{ total }]] = await Promise.all([
      db.select().from(tontinesTable).where(where).limit(limit).offset(offset).orderBy(sql`${tontinesTable.createdAt} DESC`),
      db.select({ total: count() }).from(tontinesTable).where(where),
    ]);

    return res.json({
      tontines: tontines.map(t => ({
        ...t,
        contributionAmount: Number(t.contributionAmount),
        goalAmount: t.goalAmount ? Number(t.goalAmount) : null,
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) { return next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const {
      name, description, contributionAmount, currency, frequency, maxMembers, adminUserId,
      tontine_type, is_public, is_multi_amount, goal_description, goal_amount, merchant_id,
    } = req.body;

    if (!name || !contributionAmount || !currency || !frequency || !maxMembers || !adminUserId) {
      return res.status(400).json({ error: true, message: "Missing required fields: name, contributionAmount, currency, frequency, maxMembers, adminUserId" });
    }

    if (tontine_type && !VALID_TONTINE_TYPES.has(tontine_type)) {
      return res.status(400).json({ error: true, message: `Invalid tontine_type. Must be one of: ${[...VALID_TONTINE_TYPES].join(", ")}` });
    }

    const [tontine] = await db.insert(tontinesTable).values({
      id:                 generateId(),
      name,
      description:        description        || null,
      contributionAmount: String(contributionAmount),
      currency,
      frequency,
      maxMembers:         Number(maxMembers),
      memberCount:        1,
      currentRound:       0,
      totalRounds:        Number(maxMembers),
      status:             "pending",
      tontineType:        (tontine_type      || "classic") as any,
      isPublic:           is_public          !== undefined ? Boolean(is_public)          : true,
      isMultiAmount:      is_multi_amount    !== undefined ? Boolean(is_multi_amount)    : false,
      goalDescription:    goal_description   || null,
      goalAmount:         goal_amount        ? String(goal_amount)   : null,
      merchantId:         merchant_id        || null,
      adminUserId,
    }).returning();

    await db.insert(tontineMembersTable).values({
      id: generateId(),
      tontineId:         tontine.id,
      userId:            adminUserId,
      payoutOrder:       1,
      hasReceivedPayout: 0,
      contributionsCount: 0,
    });

    return res.status(201).json({
      ...tontine,
      contributionAmount: Number(tontine.contributionAmount),
      goalAmount: tontine.goalAmount ? Number(tontine.goalAmount) : null,
    });
  } catch (err) { return next(err); }
});

router.get("/:tontineId", async (req, res, next) => {
  try {
    const { tontineId } = req.params;
    const [tontine] = await db.select().from(tontinesTable).where(eq(tontinesTable.id, tontineId));
    if (!tontine) {
      return res.status(404).json({ error: true, message: "Tontine not found" });
    }

    const members = await db
      .select({
        userId:               tontineMembersTable.userId,
        payoutOrder:          tontineMembersTable.payoutOrder,
        hasReceivedPayout:    tontineMembersTable.hasReceivedPayout,
        contributionsCount:   tontineMembersTable.contributionsCount,
        personalContribution: tontineMembersTable.personalContribution,
        firstName:            usersTable.firstName,
        lastName:             usersTable.lastName,
      })
      .from(tontineMembersTable)
      .leftJoin(usersTable, eq(tontineMembersTable.userId, usersTable.id))
      .where(eq(tontineMembersTable.tontineId, tontineId))
      .orderBy(tontineMembersTable.payoutOrder);

    const defaultAmount = Number(tontine.contributionAmount);
    const totalContributed = members.reduce((sum, m) => {
      const perMember = Number(m.personalContribution ?? defaultAmount);
      return sum + m.contributionsCount * perMember;
    }, 0);

    return res.json({
      ...tontine,
      contributionAmount: defaultAmount,
      goalAmount: tontine.goalAmount ? Number(tontine.goalAmount) : null,
      members: members.map(m => ({
        userId:               m.userId,
        userName:             `${m.firstName} ${m.lastName}`,
        payoutOrder:          m.payoutOrder,
        hasReceivedPayout:    m.hasReceivedPayout === 1,
        contributionsCount:   m.contributionsCount,
        personalContribution: m.personalContribution ? Number(m.personalContribution) : null,
      })),
      totalContributed,
    });
  } catch (err) { return next(err); }
});

export default router;
