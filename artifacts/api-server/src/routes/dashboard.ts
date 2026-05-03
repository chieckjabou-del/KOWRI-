import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable,
  walletsTable,
  transactionsTable,
  tontinesTable,
  tontineMembersTable,
  savingsPlansTable,
  productNotificationsTable,
} from "@workspace/db";
import { desc, eq, inArray, or } from "drizzle-orm";
import { requireAuth } from "../lib/productAuth";

const router = Router();

interface DashboardUser {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  status: string;
  country: string;
}

interface DashboardWallet {
  id: string;
  userId: string;
  currency: string;
  walletType: string;
  status: string;
  balance: unknown;
  availableBalance: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface DashboardTransaction {
  id: string;
  fromWalletId: string | null;
  toWalletId: string | null;
  amount: unknown;
  currency: string;
  type: string;
  status: string;
  reference: string;
  description: string | null;
  createdAt: Date;
}

interface DashboardTontine {
  id: string;
  name: string;
  description: string | null;
  contributionAmount: unknown;
  currency: string;
  frequency: string;
  maxMembers: number;
  memberCount: number;
  currentRound: number;
  totalRounds: number;
  status: string;
  tontineType: string;
  goalAmount: unknown;
  createdAt: Date;
}

interface DashboardPlan {
  id: string;
  userId: string;
  walletId: string;
  name: string;
  lockedAmount: unknown;
  interestRate: unknown;
  accruedYield: unknown;
  earlyBreakPenalty: unknown;
  status: string;
  createdAt: Date;
}

interface SavingsSummary {
  totalLocked: number;
  totalYield: number;
  activePlans: number;
  maturedPlans: number;
}

interface DashboardNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  channel: string;
  read: boolean;
  metadata: unknown;
  createdAt: Date;
}

interface DashboardStats {
  walletCount: number;
  transactionsCount: number;
  tontinesCount: number;
  activeTontines: number;
  pendingTontines: number;
  completedTontines: number;
  cancelledTontines: number;
  unreadNotifications: number;
  savings: SavingsSummary;
}

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

    const wallets = (await db
      .select()
      .from(walletsTable)
      .where(eq(walletsTable.userId, auth.userId))
      .orderBy(desc(walletsTable.createdAt))
      .limit(3)) as DashboardWallet[];

    const walletIds = wallets.map((wallet) => wallet.id);
    const primaryWallet = wallets[0] ?? null;

    const transactions: DashboardTransaction[] =
      walletIds.length === 0
        ? []
        : ((await db
            .select()
            .from(transactionsTable)
            .where(
              or(
                inArray(transactionsTable.fromWalletId, walletIds),
                inArray(transactionsTable.toWalletId, walletIds),
              ),
            )
            .orderBy(desc(transactionsTable.createdAt))
            .limit(txLimit)) as DashboardTransaction[]);

    const memberRows = (await db
      .select({ tontineId: tontineMembersTable.tontineId })
      .from(tontineMembersTable)
      .where(eq(tontineMembersTable.userId, auth.userId))
      .limit(200)) as Array<{ tontineId: string }>;

    const memberTontineIds = [...new Set(memberRows.map((row) => row.tontineId))];
    const tontines: DashboardTontine[] =
      memberTontineIds.length === 0
        ? []
        : ((await db
            .select()
            .from(tontinesTable)
            .where(inArray(tontinesTable.id, memberTontineIds))
            .orderBy(desc(tontinesTable.createdAt))
            .limit(tontineLimit)) as DashboardTontine[]);

    const plans = (await db
      .select()
      .from(savingsPlansTable)
      .where(eq(savingsPlansTable.userId, auth.userId))
      .orderBy(desc(savingsPlansTable.createdAt))
      .limit(20)) as DashboardPlan[];

    const notifications = (await db
      .select()
      .from(productNotificationsTable)
      .where(eq(productNotificationsTable.userId, auth.userId))
      .orderBy(desc(productNotificationsTable.createdAt))
      .limit(20)) as DashboardNotification[];

    const savingsSummary: SavingsSummary = {
      totalLocked: 0,
      totalYield: 0,
      activePlans: 0,
      maturedPlans: 0,
    };
    for (const plan of plans) {
      savingsSummary.totalLocked += toNumber(plan.lockedAmount);
      savingsSummary.totalYield += toNumber(plan.accruedYield);
      if (plan.status === "active") savingsSummary.activePlans += 1;
      if (plan.status === "matured") savingsSummary.maturedPlans += 1;
    }

    const notificationPayload = {
      items: notifications,
      unreadCount: notifications.filter((item) => !item.read).length,
    };

    const stats: DashboardStats = {
      walletCount: wallets.length,
      transactionsCount: transactions.length,
      tontinesCount: tontines.length,
      activeTontines: tontines.filter((item) => item.status === "active").length,
      pendingTontines: tontines.filter((item) => item.status === "pending").length,
      completedTontines: tontines.filter((item) => item.status === "completed").length,
      cancelledTontines: tontines.filter((item) => item.status === "cancelled").length,
      unreadNotifications: notificationPayload.unreadCount,
      savings: savingsSummary,
    };

    // Keep payload keys aligned with existing and upcoming frontend contracts.
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
      savings: {
        plans: plans.map((plan) => ({
          ...plan,
          lockedAmount: toNumber(plan.lockedAmount),
          interestRate: toNumber(plan.interestRate),
          accruedYield: toNumber(plan.accruedYield),
          earlyBreakPenalty: toNumber(plan.earlyBreakPenalty),
        })),
        summary: savingsSummary,
      },
      summary: {
        totalBalance: wallets.reduce((sum, wallet) => sum + toNumber(wallet.balance), 0),
        availableBalance: wallets.reduce((sum, wallet) => sum + toNumber(wallet.availableBalance), 0),
        transactionsCount: transactions.length,
        tontinesCount: tontines.length,
        savings: savingsSummary,
      },
      notifications: notificationPayload,
      stats,
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
