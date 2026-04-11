// ── Support Tickets Routes ────────────────────────────────────────────────────
// Mount at /api/support

import { Router }   from "express";
import { db }       from "@workspace/db";
import {
  supportTicketsTable,
  usersTable,
}                   from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { generateId }         from "../lib/id";
import { createNotification } from "../lib/productWallet";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

type TicketCategory = "TRANSACTION_ISSUE" | "ACCOUNT_LOCKED" | "WRONG_AMOUNT" | "AGENT_COMPLAINT" | "APP_BUG" | "OTHER";
type TicketPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

function autoPriority(category: TicketCategory, amount?: number): TicketPriority {
  if (category === "TRANSACTION_ISSUE" && amount && amount > 50_000) return "URGENT";
  if (category === "WRONG_AMOUNT")       return "HIGH";
  if (category === "AGENT_COMPLAINT")    return "HIGH";
  if (category === "ACCOUNT_LOCKED")     return "HIGH";
  if (category === "APP_BUG")            return "MEDIUM";
  return "LOW";
}

async function nextTicketNumber(): Promise<string> {
  const today = new Date();
  const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
  const result = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(supportTicketsTable)
    .where(sql`date(created_at) = current_date`);
  const seq = (Number(result[0]?.cnt ?? 0) + 1).toString().padStart(3, "0");
  return `TKT-${yyyymmdd}-${seq}`;
}

// ── POST /support/tickets ─────────────────────────────────────────────────────
router.post("/tickets", async (req, res, next) => {
  try {
    const {
      userId,
      agentId,
      category,
      title,
      description,
      linkedTransactionId,
      amount,
    } = req.body as {
      userId: string;
      agentId?: string;
      category: TicketCategory;
      title: string;
      description: string;
      linkedTransactionId?: string;
      amount?: number;
    };

    if (!userId || !category || !title || !description) {
      return res.status(400).json({ error: "userId, category, title, description required" });
    }

    const validCategories: TicketCategory[] = ["TRANSACTION_ISSUE", "ACCOUNT_LOCKED", "WRONG_AMOUNT", "AGENT_COMPLAINT", "APP_BUG", "OTHER"];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(", ")}` });
    }

    const priority  = autoPriority(category, amount);
    const ticketNumber = await nextTicketNumber();
    const id        = generateId("tkt");

    await db.insert(supportTicketsTable).values({
      id,
      ticketNumber,
      userId,
      agentId:              agentId ?? null,
      category,
      priority,
      title,
      description,
      status:               "OPEN",
      linkedTransactionId:  linkedTransactionId ?? null,
      createdAt:            new Date(),
      updatedAt:            new Date(),
    });

    await createNotification(
      userId,
      "support_ticket_created",
      "Ticket créé",
      `Votre ticket ${ticketNumber} a été créé. Notre équipe vous répondra bientôt.`,
    ).catch(() => {});

    const ticket = await db.select().from(supportTicketsTable).where(eq(supportTicketsTable.id, id)).limit(1);

    return res.status(201).json({ ticket: ticket[0], ticketNumber });
  } catch (err) { return next(err); }
});

// ── GET /support/tickets ──────────────────────────────────────────────────────
// ?userId=   → user's own tickets
// no filter  → admin: all tickets
router.get("/tickets", async (req, res, next) => {
  try {
    const { userId, status, priority, limit: lim = "50", offset: off = "0" } = req.query as Record<string, string>;

    let query = db.select().from(supportTicketsTable).$dynamic();

    const conditions = [];
    if (userId)   conditions.push(eq(supportTicketsTable.userId, userId));
    if (status)   conditions.push(eq(supportTicketsTable.status, status as any));
    if (priority) conditions.push(eq(supportTicketsTable.priority, priority as any));

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const tickets = await query
      .orderBy(desc(supportTicketsTable.createdAt))
      .limit(Number(lim))
      .offset(Number(off));

    return res.json({ tickets, count: tickets.length });
  } catch (err) { return next(err); }
});

// ── GET /support/tickets/:id ──────────────────────────────────────────────────
router.get("/tickets/:id", async (req, res, next) => {
  try {
    const ticket = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, req.params.id))
      .limit(1);

    if (!ticket.length) return res.status(404).json({ error: "Ticket not found" });
    return res.json({ ticket: ticket[0] });
  } catch (err) { return next(err); }
});

// ── PATCH /support/tickets/:id/resolve ───────────────────────────────────────
router.patch("/tickets/:id/resolve", async (req, res, next) => {
  try {
    const { resolution, assignedTo } = req.body as { resolution: string; assignedTo?: string };
    if (!resolution) return res.status(400).json({ error: "resolution required" });

    const existing = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, req.params.id))
      .limit(1);

    if (!existing.length) return res.status(404).json({ error: "Ticket not found" });

    const updated = await db
      .update(supportTicketsTable)
      .set({
        status:     "RESOLVED",
        resolution,
        assignedTo: assignedTo ?? null,
        resolvedAt: new Date(),
        updatedAt:  new Date(),
      })
      .where(eq(supportTicketsTable.id, req.params.id))
      .returning();

    await createNotification(
      existing[0].userId,
      "support_ticket_resolved",
      "Ticket résolu",
      `Votre ticket ${existing[0].ticketNumber} a été résolu. ${resolution}`,
    ).catch(() => {});

    return res.json({ ticket: updated[0] });
  } catch (err) { return next(err); }
});

// ── PATCH /support/tickets/:id/status ────────────────────────────────────────
router.patch("/tickets/:id/status", async (req, res, next) => {
  try {
    const { status, assignedTo } = req.body as { status: string; assignedTo?: string };
    const validStatuses = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
    }

    const updated = await db
      .update(supportTicketsTable)
      .set({
        status:    status as any,
        assignedTo: assignedTo ?? null,
        updatedAt: new Date(),
      })
      .where(eq(supportTicketsTable.id, req.params.id))
      .returning();

    return res.json({ ticket: updated[0] });
  } catch (err) { return next(err); }
});

export default router;
