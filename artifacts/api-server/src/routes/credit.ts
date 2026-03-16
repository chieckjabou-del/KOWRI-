import { Router } from "express";
import { db } from "@workspace/db";
import { creditScoresTable, loansTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { generateId } from "../lib/id";
import { validateQueryParams, VALID_LOAN_STATUSES } from "../middleware/validate";
import { sagaOrchestrator } from "../lib/sagaOrchestrator";
import { processDeposit } from "../lib/walletService";
import { eventBus } from "../lib/eventBus";

const router = Router();

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

export default router;
