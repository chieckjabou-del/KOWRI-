import { Router } from "express";
import {
  applyCorePenaltySettlement,
  assignCorePositions,
  collectMemberPayment,
  createCoreTontine,
  finalizeCoreCycleAndPayout,
  getCoreTontineSnapshot,
  joinCoreTontine,
} from "../lib/tontineCoreService";
import { db } from "@workspace/db";
import { tontinePenaltiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../lib/productAuth";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { routeParamString } from "../lib/routeParams";

const router = Router();

router.use(async (req, res, next) => {
  const auth = await requireAuth(req.headers.authorization);
  if (!auth) {
    return res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
  }
  return next();
});

router.post("/tontines", async (req, res) => {
  try {
    const { name, contributionAmount, currency = "XOF", frequency, maxMembers, adminUserId, description } = req.body ?? {};
    const adminId = String(adminUserId ?? "");
    if (!name || !contributionAmount || !frequency || !maxMembers || !adminId) {
      return res.status(400).json({
        error: true,
        message: "name, contributionAmount, frequency, maxMembers, adminUserId are required",
      });
    }
    const authUserId = (req as any).auth?.userId as string | undefined;
    if (authUserId && authUserId !== adminId) {
      return res.status(403).json({ error: true, message: "adminUserId must match authenticated user" });
    }
    if (!["weekly", "biweekly", "monthly"].includes(frequency)) {
      return res.status(400).json({ error: true, message: "frequency must be weekly|biweekly|monthly" });
    }

    const tontine = await createCoreTontine({
      name: String(name),
      contributionAmount: Number(contributionAmount),
      currency: String(currency),
      frequency,
      maxMembers: Number(maxMembers),
      adminUserId: adminId,
      description: description ? String(description) : undefined,
    });

    return res.status(201).json({
      ...tontine,
      contributionAmount: Number(tontine.contributionAmount),
    });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err?.message ?? "create failed" });
  }
});

router.post("/tontines/:tontineId/join", async (req, res) => {
  try {
    const tontineId = routeParamString(req, "tontineId")!;
    const userId = String(req.body?.userId ?? "");
    if (!userId) return res.status(400).json({ error: true, message: "userId required" });
    const authUserId = (req as any).auth?.userId as string | undefined;
    if (authUserId && authUserId !== userId) {
      return res.status(403).json({ error: true, message: "userId must match authenticated user" });
    }
    const member = await joinCoreTontine(tontineId, userId);
    return res.status(201).json(member);
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err?.message ?? "join failed" });
  }
});

router.post("/tontines/:tontineId/assign-positions", async (req, res) => {
  try {
    const tontineId = routeParamString(req, "tontineId")!;
    const authUserId = (req as any).auth?.userId as string | undefined;
    const snapshot = await getCoreTontineSnapshot(tontineId);
    if (snapshot?.tontine?.adminUserId && authUserId && snapshot.tontine.adminUserId !== authUserId) {
      return res.status(403).json({ error: true, message: "Only tontine admin can assign positions" });
    }
    await assignCorePositions(tontineId);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err?.message ?? "assign positions failed" });
  }
});

router.post("/tontines/:tontineId/payments", requireIdempotencyKey, checkIdempotency, async (req, res) => {
  try {
    const tontineId = routeParamString(req, "tontineId")!;
    const userId = String(req.body?.userId ?? "");
    if (!userId) return res.status(400).json({ error: true, message: "userId required" });
    const authUserId = (req as any).auth?.userId as string | undefined;
    if (authUserId && authUserId !== userId) {
      return res.status(403).json({ error: true, message: "userId must match authenticated user" });
    }

    const result = await collectMemberPayment({
      tontineId,
      userId,
      idempotencyKey: req.idempotencyKey!,
    });

    const body = {
      payment: {
        ...result.payment,
        amountDue: Number(result.payment.amountDue),
        amountPaid: Number(result.payment.amountPaid),
        penaltyAmount: Number(result.payment.penaltyAmount),
      },
      penaltyApplied: result.penaltyApplied,
    };
    await req.saveIdempotentResponse?.(body);
    return res.status(201).json(body);
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err?.message ?? "payment failed" });
  }
});

router.post("/tontines/:tontineId/cycles/finalize", requireIdempotencyKey, checkIdempotency, async (req, res) => {
  try {
    const tontineId = routeParamString(req, "tontineId")!;
    const snapshot = await getCoreTontineSnapshot(tontineId);
    const authUserId = (req as any).auth?.userId as string | undefined;
    if (snapshot?.tontine?.adminUserId && authUserId && snapshot.tontine.adminUserId !== authUserId) {
      return res.status(403).json({ error: true, message: "Only tontine admin can finalize cycle payout" });
    }
    const result = await finalizeCoreCycleAndPayout(tontineId);
    const body = {
      cycle: {
        ...result.cycle,
        expectedPool: Number(result.cycle.expectedPool),
        collectedPool: Number(result.cycle.collectedPool),
      },
      payout: {
        ...result.payout,
        amount: Number(result.payout.amount),
      },
    };
    await req.saveIdempotentResponse?.(body);
    return res.json(body);
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err?.message ?? "finalize failed" });
  }
});

router.post("/penalties/:penaltyId/settle", async (req, res) => {
  try {
    const penaltyId = routeParamString(req, "penaltyId")!;
    const authUserId = (req as any).auth?.userId as string | undefined;
    if (!authUserId) {
      return res.status(401).json({ error: true, message: "Unauthorized" });
    }
    const [penaltyRow] = await db
      .select({
        id: tontinePenaltiesTable.id,
        tontineId: tontinePenaltiesTable.tontineId,
        userId: tontinePenaltiesTable.userId,
      })
      .from(tontinePenaltiesTable)
      .where(eq(tontinePenaltiesTable.id, penaltyId));
    if (!penaltyRow) {
      return res.status(404).json({ error: true, message: "Penalty not found" });
    }
    const tontineId = penaltyRow.tontineId;
    if (tontineId) {
      const snapshot = await getCoreTontineSnapshot(tontineId).catch(() => null);
      const isPenaltyOwner = penaltyRow.userId === authUserId;
      if (!isPenaltyOwner && snapshot?.tontine?.adminUserId && snapshot.tontine.adminUserId !== authUserId) {
        return res.status(403).json({ error: true, message: "Only tontine admin can settle penalties" });
      }
    }
    const settle = req.body?.settle !== false;
    const reason = req.body?.reason ? String(req.body.reason) : undefined;
    const penalty = await applyCorePenaltySettlement({ penaltyId, settle, reason });
    return res.json({
      ...penalty,
      amount: Number(penalty.amount),
    });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err?.message ?? "penalty update failed" });
  }
});

router.get("/tontines/:tontineId/snapshot", async (req, res) => {
  try {
    const tontineId = routeParamString(req, "tontineId")!;
    const snapshot = await getCoreTontineSnapshot(tontineId);
    return res.json({
      tontine: {
        ...snapshot.tontine,
        contributionAmount: Number(snapshot.tontine.contributionAmount),
      },
      cycles: snapshot.cycles.map((c) => ({
        ...c,
        expectedPool: Number(c.expectedPool),
        collectedPool: Number(c.collectedPool),
      })),
      payments: snapshot.payments.map((p) => ({
        ...p,
        amountDue: Number(p.amountDue),
        amountPaid: Number(p.amountPaid),
        penaltyAmount: Number(p.penaltyAmount),
      })),
      payouts: snapshot.payouts.map((p) => ({
        ...p,
        amount: Number(p.amount),
      })),
      penalties: snapshot.penalties.map((p) => ({
        ...p,
        amount: Number(p.amount),
      })),
    });
  } catch (err: any) {
    return res.status(400).json({ error: true, message: err?.message ?? "snapshot failed" });
  }
});

export default router;
