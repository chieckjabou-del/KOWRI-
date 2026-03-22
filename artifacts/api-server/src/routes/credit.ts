import { Router } from "express";
import { db } from "@workspace/db";
import { creditScoresTable, loansTable, loanRepaymentsTable, walletsTable } from "@workspace/db";
import { eq, and, sql, count, desc } from "drizzle-orm";
import { generateId } from "../lib/id";
import { validateQueryParams, VALID_LOAN_STATUSES } from "../middleware/validate";
import { sagaOrchestrator } from "../lib/sagaOrchestrator";
import { processDeposit, processTransfer } from "../lib/walletService";
import { eventBus } from "../lib/eventBus";
import { computeCreditScoreFromActivity } from "../lib/reputationEngine";
import { requireAuth } from "../lib/productAuth";
import { requireIdempotencyKey, checkIdempotency } from "../middleware/idempotency";

const router = Router();

router.use(async (req, res, next) => {
  const auth = await requireAuth(req.headers.authorization);
  if (!auth) {
    res.status(401).json({ error: true, message: "Unauthorized. Provide a valid Bearer token." });
    return;
  }
  next();
});

router.get("/scores", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const [scores, [{ total }]] = await Promise.all([
      db.select().from(creditScoresTable).limit(limit).offset(offset).orderBy(sql`${creditScoresTable.score} DESC`),
      db.select({ total: count() }).from(creditScoresTable),
    ]);

    res.json({
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
    next(err);
  }
});

router.get("/scores/:userId", async (req, res, next) => {
  try {
    const [score] = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, req.params.userId));
    if (!score) {
      res.status(404).json({ error: true, message: "Credit score not found" });
      return;
    }
    res.json({
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
    next(err);
  }
});

router.get("/loans", validateQueryParams({ status: VALID_LOAN_STATUSES }), async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const where = status ? eq(loansTable.status, status as any) : undefined;

    const [loans, [{ total }]] = await Promise.all([
      db.select().from(loansTable).where(where).limit(limit).offset(offset).orderBy(sql`${loansTable.createdAt} DESC`),
      db.select({ total: count() }).from(loansTable).where(where),
    ]);

    res.json({
      loans: loans.map((l) => ({
        ...l,
        amount: Number(l.amount),
        interestRate: Number(l.interestRate),
        amountRepaid: Number(l.amountRepaid),
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/loans", async (req, res, next) => {
  try {
    const { userId, walletId, amount, currency, termDays, purpose } = req.body;
    if (!userId || !walletId || !amount || !currency || !termDays) {
      res.status(400).json({ error: true, message: "Missing required fields: userId, walletId, amount, currency, termDays" });
      return;
    }

    const [creditScore] = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, userId));
    if (!creditScore) {
      res.status(400).json({ error: true, message: "No credit score found. Build your credit history first." });
      return;
    }

    if (Number(amount) > Number(creditScore.maxLoanAmount)) {
      res.status(400).json({ error: true, message: `Loan amount exceeds maximum allowed: ${creditScore.maxLoanAmount}` });
      return;
    }

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
        amount: Number(amount),
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
          execute: async (ctx) => {
            await db.insert(loansTable).values({
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
            return ctx;
          },
          compensate: async (ctx) => {
            await db.delete(loansTable).where(eq(loansTable.id, ctx.loanId));
          },
        },
        {
          name: "disburse_funds",
          execute: async (ctx) => {
            await processDeposit({
              walletId: ctx.walletId,
              amount: ctx.amount,
              currency: ctx.currency,
              reference: `LOAN-${ctx.loanId}`,
              description: `Loan disbursement #${ctx.loanId}`,
            });
            await db.update(loansTable)
              .set({ status: "disbursed" as any, disbursedAt: new Date() })
              .where(eq(loansTable.id, ctx.loanId));
            return { ...ctx, disbursed: true };
          },
          compensate: async (ctx) => {
            await db.update(loansTable)
              .set({ status: "defaulted" as any })
              .where(eq(loansTable.id, ctx.loanId));
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
    res.status(201).json({
      ...loan,
      amount: Number(loan.amount),
      interestRate: Number(loan.interestRate),
      amountRepaid: Number(loan.amountRepaid),
      saga: { loanId: ctx.loanId, disbursed: ctx.disbursed },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/loans/:loanId", async (req, res, next) => {
  try {
    const [loan] = await db.select().from(loansTable).where(eq(loansTable.id, req.params.loanId));
    if (!loan) {
      res.status(404).json({ error: true, message: "Loan not found" });
      return;
    }
    res.json({
      ...loan,
      amount: Number(loan.amount),
      interestRate: Number(loan.interestRate),
      amountRepaid: Number(loan.amountRepaid),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/repayments", async (req, res, next) => {
  try {
    const { userId, loanId, status } = req.query;
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

    res.json({
      repayments: repayments.map(r => ({ ...r, amount: Number(r.amount) })),
      count:       repayments.length,
      totalAmount,
    });
  } catch (err) { next(err); }
});

router.get("/loans/:loanId/repayments", async (req, res, next) => {
  try {
    const repayments = await db.select().from(loanRepaymentsTable)
      .where(eq(loanRepaymentsTable.loanId, req.params.loanId))
      .orderBy(desc(loanRepaymentsTable.createdAt));
    res.json({
      repayments: repayments.map(r => ({ ...r, amount: Number(r.amount) })),
      count: repayments.length,
    });
  } catch (err) { next(err); }
});

router.post("/loans/:loanId/repay", requireIdempotencyKey, checkIdempotency, async (req, res, next) => {
  try {
    const { walletId, amount, userId } = req.body;
    if (!walletId || !amount || !userId) {
      return res.status(400).json({ error: true, message: "walletId, amount, userId required" });
    }

    const [loan] = await db.select().from(loansTable).where(eq(loansTable.id, req.params.loanId));
    if (!loan) return res.status(404).json({ error: true, message: "Loan not found" });
    if (loan.userId !== userId) return res.status(403).json({ error: true, message: "Forbidden" });
    if (!["approved", "disbursed"].includes(loan.status)) {
      return res.status(400).json({ error: true, message: `Cannot repay loan with status: ${loan.status}` });
    }

    const loanWallet = await db.select().from(walletsTable).where(eq(walletsTable.userId, "system")).limit(1);
    const systemWalletId = loanWallet[0]?.id;

    let txId: string | null = null;
    if (systemWalletId) {
      const tx = await processTransfer({
        fromWalletId: walletId,
        toWalletId:   systemWalletId,
        amount:       Number(amount),
        currency:     loan.currency,
        description:  `Loan repayment – ${loan.id}`,
        skipFraudCheck: true,
      });
      txId = tx.id;
    }

    const repaymentId = generateId();
    await db.insert(loanRepaymentsTable).values({
      id:            repaymentId,
      loanId:        loan.id,
      userId,
      amount:        String(amount),
      currency:      loan.currency,
      transactionId: txId,
      paidAt:        new Date(),
      status:        "completed",
    });

    const newRepaid = Number(loan.amountRepaid) + Number(amount);
    const isFullyRepaid = newRepaid >= Number(loan.amount);

    await db.update(loansTable).set({
      amountRepaid: String(newRepaid),
      status:       isFullyRepaid ? "repaid" : loan.status,
      updatedAt:    new Date(),
    }).where(eq(loansTable.id, loan.id));

    await eventBus.publish("loan.repayment.made", {
      loanId: loan.id, userId, amount: Number(amount), newRepaid, isFullyRepaid,
    });

    const body = {
      repaymentId,
      loanId:       loan.id,
      amount:       Number(amount),
      newRepaid,
      remaining:    Math.max(0, Number(loan.amount) - newRepaid),
      isFullyRepaid,
      message:      isFullyRepaid ? "Loan fully repaid!" : "Repayment recorded",
    };
    await req.saveIdempotentResponse?.(body);
    res.status(201).json(body);
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

router.post("/scores/:userId/compute", async (req, res, next) => {
  try {
    const factors = await computeCreditScoreFromActivity(req.params.userId);

    const score = factors.composite;
    const tier = score >= 80 ? "platinum" : score >= 60 ? "gold" : score >= 40 ? "silver" : "bronze";
    const maxLoanAmount = { bronze: 50000, silver: 200000, gold: 500000, platinum: 2000000 }[tier] ?? 50000;
    const interestRate  = { bronze: 12, silver: 10, gold: 8, platinum: 6 }[tier] ?? 12;

    const existing = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, req.params.userId));

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
        updatedAt:           new Date(),
      }).where(eq(creditScoresTable.userId, req.params.userId)).returning();
      result = updated;
    } else {
      const [created] = await db.insert(creditScoresTable).values({
        id:                  generateId(),
        userId:              req.params.userId,
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

    res.json({
      ...result,
      maxLoanAmount: Number(result.maxLoanAmount),
      interestRate:  Number(result.interestRate),
      factors,
    });
  } catch (err: any) {
    res.status(400).json({ error: true, message: err.message });
  }
});

export default router;
