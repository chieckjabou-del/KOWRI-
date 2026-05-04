import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth } from "../lib/productAuth";

const router = Router();

type NumericRow = { value: number | string | null };
type TxByTypeRow = { type: string; count: number; volume: number };
type NewUsersPoint = { date: string; newUsers: number };
type ActivatedUsersPoint = { date: string; activatedUsers: number };

function periodToDays(period: string | undefined): number {
  if (period === "7d") return 7;
  if (period === "90d") return 90;
  return 30;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function getSingleMetric(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(query);
  const row = (result.rows?.[0] ?? null) as NumericRow | null;
  return toNumber(row?.value);
}

router.get("/mvp", async (req, res, next) => {
  try {
    const auth = await requireAuth(req.headers.authorization);
    if (!auth) {
      return res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
    }

    // Keep founder mode private in production, but allow open access in environments
    // where allowlist is not configured yet.
    const allowlist = (process.env.FOUNDER_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const founderAllowed = allowlist.length === 0 || allowlist.includes(auth.userId);
    if (!founderAllowed) {
      return res.status(403).json({ error: true, message: "Founder access required." });
    }

    const periodParam = typeof req.query.period === "string" ? req.query.period : "30d";
    const periodDays = periodToDays(periodParam);
    const periodLabel = `${periodDays}d`;

    const [
      totalUsers,
      newUsersInPeriod,
      walletsAdopted,
      activeTontines,
      totalTontineMembers,
      totalTontines,
      transactionsCompleted,
      totalTransactions,
      transactionVolume,
      usersWithCompletedTx,
      usersWithTwoCompletedTx,
      transactingUsers7d,
      transactingUsers30d,
      activeSavingsUsers,
      avgFirstValueHours,
    ] = await Promise.all([
      getSingleMetric(sql`SELECT COUNT(*)::float AS value FROM users`),
      getSingleMetric(
        sql`SELECT COUNT(*)::float AS value FROM users WHERE created_at >= NOW() - (${periodDays} || ' days')::interval`,
      ),
      getSingleMetric(sql`SELECT COUNT(DISTINCT user_id)::float AS value FROM wallets`),
      getSingleMetric(sql`SELECT COUNT(*)::float AS value FROM tontines WHERE status = 'active'`),
      getSingleMetric(sql`SELECT COUNT(*)::float AS value FROM tontine_members`),
      getSingleMetric(sql`SELECT COUNT(*)::float AS value FROM tontines`),
      getSingleMetric(
        sql`SELECT COUNT(*)::float AS value FROM transactions WHERE status = 'completed' AND created_at >= NOW() - (${periodDays} || ' days')::interval`,
      ),
      getSingleMetric(
        sql`SELECT COUNT(*)::float AS value FROM transactions WHERE created_at >= NOW() - (${periodDays} || ' days')::interval`,
      ),
      getSingleMetric(
        sql`SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0)::float AS value FROM transactions WHERE status = 'completed' AND created_at >= NOW() - (${periodDays} || ' days')::interval`,
      ),
      getSingleMetric(sql`
        SELECT COUNT(DISTINCT w.user_id)::float AS value
        FROM transactions t
        JOIN wallets w ON (t.from_wallet_id = w.id OR t.to_wallet_id = w.id)
        WHERE t.status = 'completed'
          AND t.created_at >= NOW() - (${periodDays} || ' days')::interval
      `),
      getSingleMetric(sql`
        SELECT COALESCE(COUNT(*), 0)::float AS value
        FROM (
          SELECT w.user_id
          FROM transactions t
          JOIN wallets w ON (t.from_wallet_id = w.id OR t.to_wallet_id = w.id)
          WHERE t.status = 'completed'
            AND t.created_at >= NOW() - (${periodDays} || ' days')::interval
          GROUP BY w.user_id
          HAVING COUNT(*) >= 2
        ) repeat_users
      `),
      getSingleMetric(sql`
        SELECT COUNT(DISTINCT w.user_id)::float AS value
        FROM transactions t
        JOIN wallets w ON (t.from_wallet_id = w.id OR t.to_wallet_id = w.id)
        WHERE t.status = 'completed'
          AND t.created_at >= NOW() - INTERVAL '7 days'
      `),
      getSingleMetric(sql`
        SELECT COUNT(DISTINCT w.user_id)::float AS value
        FROM transactions t
        JOIN wallets w ON (t.from_wallet_id = w.id OR t.to_wallet_id = w.id)
        WHERE t.status = 'completed'
          AND t.created_at >= NOW() - INTERVAL '30 days'
      `),
      getSingleMetric(
        sql`SELECT COUNT(DISTINCT user_id)::float AS value FROM savings_plans WHERE status = 'active'`,
      ),
      getSingleMetric(sql`
        SELECT COALESCE(
          AVG(EXTRACT(EPOCH FROM (first_tx.first_tx_at - u.created_at)) / 3600),
          0
        )::float AS value
        FROM users u
        JOIN (
          SELECT w.user_id, MIN(t.created_at) AS first_tx_at
          FROM transactions t
          JOIN wallets w ON (t.from_wallet_id = w.id OR t.to_wallet_id = w.id)
          WHERE t.status = 'completed'
          GROUP BY w.user_id
        ) first_tx ON first_tx.user_id = u.id
        WHERE u.created_at >= NOW() - (${periodDays} || ' days')::interval
      `),
    ]);

    const txByTypeResult = await db.execute(sql`
      SELECT
        type,
        COUNT(*)::int AS count,
        COALESCE(SUM(CAST(amount AS NUMERIC)), 0)::float AS volume
      FROM transactions
      WHERE status = 'completed'
        AND created_at >= NOW() - (${periodDays} || ' days')::interval
      GROUP BY type
      ORDER BY volume DESC
    `);
    const txByType = (txByTypeResult.rows ?? []) as TxByTypeRow[];

    const newUsersSeriesResult = await db.execute(sql`
      SELECT
        gs::date AS date,
        COALESCE(u.cnt, 0)::int AS "newUsers"
      FROM generate_series(
        NOW()::date - (${periodDays} - 1),
        NOW()::date,
        INTERVAL '1 day'
      ) gs
      LEFT JOIN (
        SELECT DATE(created_at) AS dt, COUNT(*)::int AS cnt
        FROM users
        WHERE created_at >= NOW() - (${periodDays} || ' days')::interval
        GROUP BY DATE(created_at)
      ) u ON u.dt = gs::date
      ORDER BY gs
    `);
    const newUsersSeries = (newUsersSeriesResult.rows ?? []) as NewUsersPoint[];

    const activatedUsersSeriesResult = await db.execute(sql`
      SELECT
        gs::date AS date,
        COALESCE(a.cnt, 0)::int AS "activatedUsers"
      FROM generate_series(
        NOW()::date - (${periodDays} - 1),
        NOW()::date,
        INTERVAL '1 day'
      ) gs
      LEFT JOIN (
        SELECT DATE(t.created_at) AS dt, COUNT(DISTINCT w.user_id)::int AS cnt
        FROM transactions t
        JOIN wallets w ON (t.from_wallet_id = w.id OR t.to_wallet_id = w.id)
        WHERE t.status = 'completed'
          AND t.created_at >= NOW() - (${periodDays} || ' days')::interval
        GROUP BY DATE(t.created_at)
      ) a ON a.dt = gs::date
      ORDER BY gs
    `);
    const activatedUsersSeries = (activatedUsersSeriesResult.rows ?? []) as ActivatedUsersPoint[];

    const walletAdoptionRate = totalUsers > 0 ? (walletsAdopted / totalUsers) * 100 : 0;
    const txSuccessRate = totalTransactions > 0 ? (transactionsCompleted / totalTransactions) * 100 : 0;
    const activationRate = newUsersInPeriod > 0 ? (usersWithCompletedTx / newUsersInPeriod) * 100 : 0;
    const repeatUserRate =
      usersWithCompletedTx > 0 ? (usersWithTwoCompletedTx / usersWithCompletedTx) * 100 : 0;
    const wauMauProxy = transactingUsers30d > 0 ? (transactingUsers7d / transactingUsers30d) * 100 : 0;
    const savingsStickiness = walletsAdopted > 0 ? (activeSavingsUsers / walletsAdopted) * 100 : 0;
    const avgTontineFillRate = totalTontines > 0 ? totalTontineMembers / totalTontines : 0;

    return res.json({
      period: periodLabel,
      generatedAt: new Date().toISOString(),
      founderGuardOpen: allowlist.length === 0,
      kpis: {
        activationRate,
        walletAdoptionRate,
        txSuccessRate,
        repeatUserRate,
        wauMauProxy,
        savingsStickiness,
        avgFirstValueHours,
        avgTontineFillRate,
      },
      totals: {
        totalUsers,
        newUsersInPeriod,
        walletsAdopted,
        activeTontines,
        transactionsCompleted,
        transactionVolume,
        activeSavingsUsers,
      },
      series: {
        newUsers: newUsersSeries,
        activatedUsers: activatedUsersSeries,
      },
      breakdowns: {
        txByType,
      },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
