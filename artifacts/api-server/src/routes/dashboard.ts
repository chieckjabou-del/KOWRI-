import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable,
  walletsTable,
  transactionsTable,
  tontinesTable,
  tontineMembersTable,
  savingsPlansTable,
} from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { requireAuth } from "../lib/productAuth";

const router = Router();

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

router.get("/", async (req, res, next) => {
  try {
    const auth = await requireAuth(req.headers.authorization);
    if (!auth) {
      return res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
    }

    const txLimitRaw = Number(req.query.txLimit);
    const tontineLimitRaw = Number(req.query.tontineLimit);
    const txLimit = Number.isFinite(txLimitRaw) && txLimitRaw > 0 ? Math.min(txLimitRaw, 50) : 8;
    const tontineLimit = Number.isFinite(tontineLimitRaw) && tontineLimitRaw > 0 ? Math.min(tontineLimitRaw, 50) : 8;

    const [user] = await db
      .select({
        id: usersTable.id,
        phone: usersTable.phone,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        status: usersTable.status,
        country: usersTable.country,
      })
      .from(usersTable)
      .where(eq(usersTable.id, auth.userId))
      .limit(1);

    if (!user) {
      return res.status(404).json({ error: true, message: "User not found" });
    }

    const wallets = await db
      .select()
      .from(walletsTable)
      .where(eq(walletsTable.userId, auth.userId))
      .orderBy(desc(walletsTable.createdAt))
      .limit(3);

    const walletIds = wallets.map((wallet) => wallet.id);
    const primaryWallet = wallets[0] ?? null;

    const transactions =
      walletIds.length === 0
        ? []
        : await db
            .select()
            .from(transactionsTable)
            .where(
              or(
                inArray(transactionsTable.fromWalletId, walletIds),
                inArray(transactionsTable.toWalletId, walletIds),
              ),
            )
            .orderBy(desc(transactionsTable.createdAt))
            .limit(txLimit);

    const memberRows = await db
      .select({ tontineId: tontineMembersTable.tontineId })
      .from(tontineMembersTable)
      .where(eq(tontineMembersTable.userId, auth.userId))
      .limit(200);

    const memberTontineIds = [...new Set(memberRows.map((row) => row.tontineId))];
    const tontines =
      memberTontineIds.length === 0
        ? []
        : await db
            .select()
            .from(tontinesTable)
            .where(inArray(tontinesTable.id, memberTontineIds))
            .orderBy(desc(tontinesTable.createdAt))
            .limit(tontineLimit);

    const plans = await db
      .select()
      .from(savingsPlansTable)
      .where(eq(savingsPlansTable.userId, auth.userId))
      .orderBy(desc(savingsPlansTable.createdAt))
      .limit(20);

    const savingsSummary = plans.reduce(
      (acc, plan) => {
        const lockedAmount = toNumber(plan.lockedAmount);
        const accruedYield = toNumber(plan.accruedYield);
        acc.totalLocked += lockedAmount;
        acc.totalYield += accruedYield;
        if (plan.status === "active") acc.activePlans += 1;
        if (plan.status === "matured") acc.maturedPlans += 1;
        return acc;
      },
      { totalLocked: 0, totalYield: 0, activePlans: 0, maturedPlans: 0 },
    );

    // Keep payload keys aligned with existing frontend service contracts.
    return res.json({
      user,
      wallets: wallets.map((wallet) => ({
        ...wallet,
        balance: toNumber(wallet.balance),
        availableBalance: toNumber(wallet.availableBalance),
      })),
      primaryWallet: primaryWallet
        ? {
            ...primaryWallet,
            balance: toNumber(primaryWallet.balance),
            availableBalance: toNumber(primaryWallet.availableBalance),
          }
        : null,
      transactions: transactions.map((tx) => ({ ...tx, amount: toNumber(tx.amount) })),
      tontines: tontines.map((tontine) => ({
        ...tontine,
        contributionAmount: toNumber(tontine.contributionAmount),
        goalAmount: tontine.goalAmount ? toNumber(tontine.goalAmount) : null,
      })),
      plans: plans.map((plan) => ({
        ...plan,
        lockedAmount: toNumber(plan.lockedAmount),
        interestRate: toNumber(plan.interestRate),
        accruedYield: toNumber(plan.accruedYield),
        earlyBreakPenalty: toNumber(plan.earlyBreakPenalty),
      })),
      summary: {
        totalBalance: wallets.reduce((sum, wallet) => sum + toNumber(wallet.balance), 0),
        availableBalance: wallets.reduce((sum, wallet) => sum + toNumber(wallet.availableBalance), 0),
        transactionsCount: transactions.length,
        tontinesCount: tontines.length,
        savings: savingsSummary,
      },
      meta: {
        generatedAt: new Date().toISOString(),
        sessionType: auth.type,
      },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
