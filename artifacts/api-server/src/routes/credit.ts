import { Router } from "express";
import { db } from "@workspace/db";
import { creditScoresTable, loansTable, loanRepaymentsTable } from "@workspace/db";
import { eq, and, sql, count, desc } from "drizzle-orm";
import { generateId } from "../lib/id";
import { validateQueryParams, VALID_LOAN_STATUSES } from "../middleware/validate";
import { sagaOrchestrator } from "../lib/sagaOrchestrator";
import { processTransfer, reverseTransaction, lockEntity, normalizeAmount } from "../lib/walletService";
import { AppError } from "../middleware/errorHandler";
import { eventBus } from "../lib/eventBus";
import { computeCreditScoreFromActivity } from "../lib/reputationEngine";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";
import { routeParamString } from "../lib/routeParams";

// The treasury wallet for the loan's currency cannot cover the disbursement.
class TreasuryLiquidityError extends Error {
  constructor(currency: string) {
    super(`Platform treasury has insufficient ${currency} liquidity for this loan`);
    this.name = "TreasuryLiquidityError";
  }
}

import { authenticate, walletBelongsToUser, isAdminRequest, requireSelfOrAdmin } from "../middleware/auth";
import { getTreasuryWallet } from "../lib/treasury";

const router = Router();

router.use(authenticate());

// Every read is scoped to the caller unless the caller is an operator: a user
// only ever sees their own score, loans and repayments.
function scopedUserId(req: import("express").Request): string | undefined {
  return isAdminRequest(req) ? undefined : req.auth!.userId;
}

async function loadLoanForCaller(req: import("express").Request, loanId: string) {
  const [loan] = await db.select().from(loansTable).where(eq(loansTable.id, loanId));
  if (!loan) return { status: 404 as const, loan: null };
  if (!isAdminRequest(req) && loan.userId !== req.auth!.userId) return { status: 403 as const, loan: null };
  return { status: 200 as const, loan };
}

router.get("/scores", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const owner = scopedUserId(req);
    const where = owner ? eq(creditScoresTable.userId, owner) : undefined;

    const [scores, [{ total }]] = await Promise.all([
      db.select().from(creditScoresTable).where(where).limit(limit).offset(offset).orderBy(sql`${creditScoresTable.score} DESC`),
      db.select({ total: count() }).from(creditScoresTable).where(where),
    ]);

    return res.json({
      scores: scores.map((s) => ({
        ...s,
        maxLoanAmount: Number(s.maxLoanAmount),
        interestRate: Number(s.interestRate),
        factors: {
          paymentHistory: s.paymentHistory,
          savingsRegularity: s.savingsRegularity,
          transactionVolume: s.transactionVolume,
          tontineParticipation: s.tontineParticipation,
          networkScore: s.networkScore,
        },
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/scores/:userId", requireSelfOrAdmin("userId"), async (req, res, next) => {
  try {
    const userId = routeParamString(req, "userId")!;
    const [score] = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, userId));
    if (!score) {
      return res.status(404).json({ error: true, message: "Credit score not found" });
    }
    return res.json({
      ...score,
      maxLoanAmount: Number(score.maxLoanAmount),
      interestRate: Number(score.interestRate),
      factors: {
        paymentHistory: score.paymentHistory,
        savingsRegularity: score.savingsRegularity,
        transactionVolume: score.transactionVolume,
        tontineParticipation: score.tontineParticipation,
        networkScore: score.networkScore,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/loans", validateQueryParams({ status: VALID_LOAN_STATUSES }), async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;
    const owner = scopedUserId(req);

    const where = and(
      status ? eq(loansTable.status, status as any) : undefined,
      owner ? eq(loansTable.userId, owner) : undefined,
    );

    const [loans, [{ total }]] = await Promise.all([
      db.select().from(loansTable).where(where).limit(limit).offset(offset).orderBy(sql`${loansTable.createdAt} DESC`),
      db.select({ total: count() }).from(loansTable).where(where),
    ]);

    return res.json({
      loans: loans.map((l) => ({
        ...l,
        amount: Number(l.amount),
        interestRate: Number(l.interestRate),
        amountRepaid: Number(l.amountRepaid),
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/loans", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { walletId, amount, currency, termDays, purpose } = req.body;
    const userId = req.auth!.userId;
    if (!walletId || !amount || !currency || !termDays) {
      return res.status(400).json({ error: true, message: "Missing required fields: walletId, amount, currency, termDays" });
    }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: true, message: "amount must be a positive number" });
    }
    if (!(await walletBelongsToUser(String(walletId), userId))) {
      return res.status(403).json({ error: true, message: "You do not own this wallet" });
    }

    const [creditScore] = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, userId));
    if (!creditScore) {
      return res.status(400).json({ error: true, message: "No credit score found. Build your credit history first." });
    }

    if (Number(amount) > Number(creditScore.maxLoanAmount)) {
      return res.status(400).json({ error: true, message: `Loan amount exceeds maximum allowed: ${creditScore.maxLoanAmount}` });
    }

    const requested = normalizeAmount(Number(amount));
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + Number(termDays));
    const loanId = generateId();

    interface LoanCtx extends Record<string, unknown> {
      loanId: string;
      userId: string;
      walletId: string;
      amount: number;
      currency: string;
      termDays: number;
      dueDate: Date;
      purpose: string | null;
      interestRate: string;
      disbursed: boolean;
    }

    const ctx = await sagaOrchestrator.execute<LoanCtx>(
      "loan_disbursement",
      {
        loanId,
        userId,
        walletId,
        amount: requested,
        currency,
        termDays: Number(termDays),
        dueDate,
        purpose: purpose || null,
        interestRate: creditScore.interestRate,
        disbursed: false,
      },
      [
        {
          name: "create_loan_record",
          // The credit line is a ceiling on the borrower's TOTAL outstanding
          // principal, not on each loan taken separately. The check and the
          // insert run under a per-user lock so parallel requests cannot each
          // pass the check before any of them is recorded.
          execute: async (ctx) => {
            await db.transaction(async (tx) => {
              await lockEntity(tx as any, "loan-user", ctx.userId);
              const [exposure] = await tx.select({
                outstanding: sql<number>`COALESCE(SUM(CAST(${loansTable.amount} AS NUMERIC) - CAST(${loansTable.amountRepaid} AS NUMERIC)), 0)`,
              }).from(loansTable).where(and(
                eq(loansTable.userId, ctx.userId),
                sql`${loansTable.status} IN ('pending', 'approved', 'disbursed')`,
              ));
              const outstanding = Number(exposure?.outstanding ?? 0);
              const ceiling = Number(creditScore.maxLoanAmount);
              if (outstanding + ctx.amount > ceiling + 1e-6) {
                throw new AppError(409, `Outstanding credit ${outstanding} plus ${ctx.amount} exceeds your credit line of ${ceiling}`);
              }
              await tx.insert(loansTable).values({
                id: ctx.loanId,
                userId: ctx.userId,
                walletId: ctx.walletId,
                amount: String(ctx.amount),
                currency: ctx.currency,
                interestRate: ctx.interestRate,
                termDays: ctx.termDays,
                status: "approved",
                amountRepaid: "0",
                purpose: ctx.purpose,
                dueDate: ctx.dueDate,
              });
            });
            return ctx;
          },
          compensate: async (ctx) => {
            await db.delete(loansTable).where(eq(loansTable.id, ctx.loanId));
          },
        },
        {
          name: "disburse_funds",
          // Real money leaves the platform treasury: the ledger stays balanced and
          // the loan book can be reconciled against the treasury wallet.
          execute: async (ctx) => {
            const treasury = await getTreasuryWallet(ctx.currency);
            let tx;
            try {
              tx = await processTransfer({
                fromWalletId: treasury.id,
                toWalletId: ctx.walletId,
                amount: ctx.amount,
                currency: ctx.currency,
                reference: `LOAN-${ctx.loanId}`,
                description: `Loan disbursement #${ctx.loanId}`,
                idempotencyKey: `loan-disburse:${ctx.loanId}`,
                skipKycCheck: true, skipFraudCheck: true, skipRateLimitCheck: true,
                // The loan is marked disbursed in the same transaction as the money.
                attach: async (t) => {
                  await t.update(loansTable)
                    .set({ status: "disbursed" as any, disbursedAt: new Date() })
                    .where(eq(loansTable.id, ctx.loanId));
                },
              });
            } catch (err) {
              if (err instanceof Error && err.message === "Insufficient funds") {
                throw new TreasuryLiquidityError(ctx.currency);
              }
              throw err;
            }
            return { ...ctx, disbursed: true, disbursementTxId: tx.id };
          },
          // Undo the actual money movement, then record the loan as never having gone out.
          compensate: async (ctx) => {
            const txId = (ctx as any).disbursementTxId as string | undefined;
            if (txId) {
              await reverseTransaction({ transactionId: txId, reason: `Loan ${ctx.loanId} saga compensation`, idempotencyKey: `loan-disburse:${ctx.loanId}:reversal` });
            }
            await db.delete(loansTable).where(eq(loansTable.id, ctx.loanId));
          },
        },
        {
          name: "emit_loan_disbursed",
          execute: async (ctx) => {
            await eventBus.publish("loan.disbursed", {
              loanId: ctx.loanId,
              userId: ctx.userId,
              walletId: ctx.walletId,
              amount: ctx.amount,
              currency: ctx.currency,
            });
            return ctx;
          },
          compensate: async (ctx) => {
            await eventBus.publish("loan.failed", {
              loanId: ctx.loanId,
              userId: ctx.userId,
              reason: "saga_compensation",
            });
          },
        },
        {
          name: "notify_borrower",
          execute: async (ctx) => {
            console.log(`[Notify] Loan ${ctx.loanId} disbursed to user ${ctx.userId}: ${ctx.amount} ${ctx.currency}`);
            return ctx;
          },
        },
      ]
    );

    const [loan] = await db.select().from(loansTable).where(eq(loansTable.id, loanId));
    const body = {
      ...loan,
      amount: Number(loan.amount),
      interestRate: Number(loan.interestRate),
      amountRepaid: Number(loan.amountRepaid),
      saga: { loanId: ctx.loanId, disbursed: ctx.disbursed },
    };
    await req.saveIdempotentResponse?.(body);
    return res.status(201).json(body);
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    if (cause instanceof TreasuryLiquidityError) {
      return res.status(503).json({ error: true, code: "TREASURY_LIQUIDITY", message: cause.message });
    }
    if (cause instanceof AppError) {
      return res.status(cause.statusCode).json({ error: true, code: "CREDIT_LINE_EXCEEDED", message: cause.message });
    }
    return next(cause);
  }
});

router.get("/loans/:loanId", async (req, res, next) => {
  try {
    const loanId = routeParamString(req, "loanId")!;
    const { status, loan } = await loadLoanForCaller(req, loanId);
    if (!loan) {
      return res.status(status).json({ error: true, message: status === 404 ? "Loan not found" : "Forbidden" });
    }
    return res.json({
      ...loan,
      amount: Number(loan.amount),
      interestRate: Number(loan.interestRate),
      amountRepaid: Number(loan.amountRepaid),
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/repayments", async (req, res, next) => {
  try {
    const { userId: requestedUserId, loanId, status } = req.query;
    // A user always gets their own repayments, whatever userId they ask for.
    const userId = scopedUserId(req) ?? requestedUserId;
    if (!userId && !loanId) {
      return res.status(400).json({ error: true, message: "userId or loanId required" });
    }

    const conditions = [
      userId ? eq(loanRepaymentsTable.userId, userId as string) : undefined,
      loanId ? eq(loanRepaymentsTable.loanId, loanId as string) : undefined,
      status ? eq(loanRepaymentsTable.status, status as string) : undefined,
    ].filter(Boolean) as any[];

    const repayments = await db.select().from(loanRepaymentsTable)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(desc(loanRepaymentsTable.createdAt))
      .limit(100);

    const totalAmount = repayments.reduce((s, r) => s + Number(r.amount), 0);

    return res.json({
      repayments: repayments.map(r => ({ ...r, amount: Number(r.amount) })),
      count:       repayments.length,
      totalAmount,
    });
  } catch (err) { return next(err); }
});

router.get("/loans/:loanId/repayments", async (req, res, next) => {
  try {
    const loanId = routeParamString(req, "loanId")!;
    const { status, loan } = await loadLoanForCaller(req, loanId);
    if (!loan) {
      return res.status(status).json({ error: true, message: status === 404 ? "Loan not found" : "Forbidden" });
    }
    const repayments = await db.select().from(loanRepaymentsTable)
      .where(eq(loanRepaymentsTable.loanId, loanId))
      .orderBy(desc(loanRepaymentsTable.createdAt));
    return res.json({
      repayments: repayments.map(r => ({ ...r, amount: Number(r.amount) })),
      count: repayments.length,
    });
  } catch (err) { return next(err); }
});

router.post("/loans/:loanId/repay", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { walletId, amount } = req.body;
    const userId = req.auth!.userId;
    if (!walletId || !amount) {
      return res.status(400).json({ error: true, message: "walletId, amount required" });
    }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: true, message: "amount must be a positive number" });
    }
    if (!(await walletBelongsToUser(String(walletId), userId))) {
      return res.status(403).json({ error: true, message: "You do not own this wallet" });
    }

    const loanId = routeParamString(req, "loanId")!;
    const [loan] = await db.select().from(loansTable).where(eq(loansTable.id, loanId));
    if (!loan) return res.status(404).json({ error: true, message: "Loan not found" });
    if (loan.userId !== userId) return res.status(403).json({ error: true, message: "Forbidden" });
    if (!["approved", "disbursed"].includes(loan.status)) {
      return res.status(400).json({ error: true, message: `Cannot repay loan with status: ${loan.status}` });
    }
    const outstanding = Number(loan.amount) - Number(loan.amountRepaid);
    if (Number(amount) > outstanding + 1e-6) {
      return res.status(400).json({ error: true, message: `Repayment exceeds outstanding balance (${outstanding})` });
    }

    // The repayment is a real transfer back to the platform treasury. The loan
    // row is locked and re-checked INSIDE the ledger transaction, and the
    // repayment record and the new balance are written there too: two
    // simultaneous repayments cannot both be accepted, and the money can never
    // leave the borrower's wallet without the loan being credited for it.
    const treasury = await getTreasuryWallet(loan.currency);
    const repaymentId = generateId();
    const repayAmount = normalizeAmount(Number(amount));
    let newRepaid = 0;
    let isFullyRepaid = false;
    const tx = await processTransfer({
      fromWalletId: walletId,
      toWalletId:   treasury.id,
      amount:       repayAmount,
      currency:     loan.currency,
      reference:    `LOAN-REPAY-${repaymentId}`,   // transaction references are unique
      description:  `Loan repayment – ${loan.id}`,
      skipFraudCheck: true,
      idempotencyKey: `loan-repay:${userId}:${req.idempotencyKey}`,
      attach: async (t) => {
        const [fresh] = await t.select().from(loansTable).where(eq(loansTable.id, loan.id)).for("update");
        if (!fresh) throw new AppError(404, "Loan not found");
        if (!["approved", "disbursed"].includes(fresh.status)) {
          throw new AppError(409, `Cannot repay loan with status: ${fresh.status}`);
        }
        const remaining = Number(fresh.amount) - Number(fresh.amountRepaid);
        if (repayAmount > remaining + 1e-6) {
          throw new AppError(409, `Repayment exceeds outstanding balance (${remaining})`);
        }
        newRepaid = Math.round((Number(fresh.amountRepaid) + repayAmount) * 10000) / 10000;
        isFullyRepaid = newRepaid + 1e-6 >= Number(fresh.amount);
        await t.insert(loanRepaymentsTable).values({
          id:            repaymentId,
          loanId:        loan.id,
          userId,
          amount:        String(repayAmount),
          currency:      loan.currency,
          transactionId: null, // the ledger transaction id is not known until commit; see reference LOAN-REPAY-<id>
          paidAt:        new Date(),
          status:        "completed",
        });
        await t.update(loansTable).set({
          amountRepaid: String(newRepaid),
          status:       isFullyRepaid ? "repaid" : fresh.status,
          updatedAt:    new Date(),
        }).where(eq(loansTable.id, loan.id));
      },
    });
    await db.update(loanRepaymentsTable).set({ transactionId: tx.id }).where(eq(loanRepaymentsTable.id, repaymentId));

    await eventBus.publish("loan.repayment.made", {
      loanId: loan.id, userId, amount: repayAmount, newRepaid, isFullyRepaid,
    });

    const body = {
      repaymentId,
      loanId:       loan.id,
      transactionId: tx.id,
      amount:       repayAmount,
      newRepaid,
      remaining:    Math.max(0, Number(loan.amount) - newRepaid),
      isFullyRepaid,
      message:      isFullyRepaid ? "Loan fully repaid!" : "Repayment recorded",
    };
    await req.saveIdempotentResponse?.(body);
    return res.status(201).json(body);
  } catch (err) {
    // Business errors (insufficient funds, frozen wallet, kill switch) are mapped by the error handler.
    return next(err);
  }
});

router.post("/scores/:userId/compute", requireSelfOrAdmin("userId"), async (req, res, next) => {
  try {
    const userId = routeParamString(req, "userId")!;
    const factors = await computeCreditScoreFromActivity(userId);

    const score = factors.composite;
    const tier = score >= 80 ? "platinum" : score >= 60 ? "gold" : score >= 40 ? "silver" : "bronze";
    const maxLoanAmount = { bronze: 50000, silver: 200000, gold: 500000, platinum: 2000000 }[tier] ?? 50000;
    const interestRate  = { bronze: 12, silver: 10, gold: 8, platinum: 6 }[tier] ?? 12;

    const existing = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, userId));

    let result;
    if (existing[0]) {
      const [updated] = await db.update(creditScoresTable).set({
        score,
        tier,
        maxLoanAmount:       String(maxLoanAmount),
        interestRate:        String(interestRate),
        paymentHistory:      factors.paymentHistory,
        savingsRegularity:   factors.savingsRegularity,
        transactionVolume:   factors.transactionVolume,
        tontineParticipation: factors.tontineParticipation,
        networkScore:        factors.networkScore,
        lastUpdated:         new Date(),
      }).where(eq(creditScoresTable.userId, userId)).returning();
      result = updated;
    } else {
      const [created] = await db.insert(creditScoresTable).values({
        id:                  generateId(),
        userId,
        score,
        tier,
        maxLoanAmount:       String(maxLoanAmount),
        interestRate:        String(interestRate),
        paymentHistory:      factors.paymentHistory,
        savingsRegularity:   factors.savingsRegularity,
        transactionVolume:   factors.transactionVolume,
        tontineParticipation: factors.tontineParticipation,
        networkScore:        factors.networkScore,
      }).returning();
      result = created;
    }

    return res.json({
      ...result,
      maxLoanAmount: Number(result.maxLoanAmount),
      interestRate:  Number(result.interestRate),
      factors,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
