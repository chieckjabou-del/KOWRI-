import { Router } from "express";
import { db } from "@workspace/db";
import { creditScoresTable, loansTable, usersTable, walletsTable, transactionsTable, ledgerEntriesTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { generateId, generateReference } from "../lib/id";

const router = Router();

router.get("/scores", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const [scores, [{ total }]] = await Promise.all([
      db.select().from(creditScoresTable).limit(limit).offset(offset).orderBy(sql`${creditScoresTable.score} DESC`),
      db.select({ total: count() }).from(creditScoresTable),
    ]);

    res.json({
      scores: scores.map(s => ({
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
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.get("/scores/:userId", async (req, res) => {
  try {
    const [score] = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, req.params.userId));
    if (!score) return res.status(404).json({ error: "Not found", message: "Credit score not found" });

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
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.get("/loans", async (req, res) => {
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
      loans: loans.map(l => ({
        ...l,
        amount: Number(l.amount),
        interestRate: Number(l.interestRate),
        amountRepaid: Number(l.amountRepaid),
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.post("/loans", async (req, res) => {
  try {
    const { userId, walletId, amount, currency, termDays, purpose } = req.body;
    if (!userId || !walletId || !amount || !currency || !termDays) {
      return res.status(400).json({ error: "Bad request", message: "Missing required fields" });
    }

    const [creditScore] = await db.select().from(creditScoresTable).where(eq(creditScoresTable.userId, userId));
    if (!creditScore) {
      return res.status(400).json({ error: "Bad request", message: "No credit score found. Build your credit history first." });
    }

    if (Number(amount) > Number(creditScore.maxLoanAmount)) {
      return res.status(400).json({ error: "Bad request", message: `Loan amount exceeds maximum allowed: ${creditScore.maxLoanAmount}` });
    }

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + Number(termDays));

    const [loan] = await db.insert(loansTable).values({
      id: generateId(),
      userId,
      walletId,
      amount: String(amount),
      currency,
      interestRate: creditScore.interestRate,
      termDays: Number(termDays),
      status: "approved",
      amountRepaid: "0",
      purpose: purpose || null,
      dueDate,
    }).returning();

    res.status(201).json({
      ...loan,
      amount: Number(loan.amount),
      interestRate: Number(loan.interestRate),
      amountRepaid: Number(loan.amountRepaid),
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

router.get("/loans/:loanId", async (req, res) => {
  try {
    const [loan] = await db.select().from(loansTable).where(eq(loansTable.id, req.params.loanId));
    if (!loan) return res.status(404).json({ error: "Not found", message: "Loan not found" });
    res.json({ ...loan, amount: Number(loan.amount), interestRate: Number(loan.interestRate), amountRepaid: Number(loan.amountRepaid) });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

export default router;
