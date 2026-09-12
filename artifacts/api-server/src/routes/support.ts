// ── Support Tickets Routes ────────────────────────────────────────────────────
// Mount at /api/support

import { Router }   from "express";
import { db }       from "@workspace/db";
import { supportTicketsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { generateId }         from "../lib/id";
import { createNotification } from "../lib/productWallet";
import { authenticate, isAdminRequest, requirePermission } from "../middleware/auth";
import { routeParamString } from "../lib/routeParams";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

type TicketCategory = "TRANSACTION_ISSUE" | "ACCOUNT_LOCKED" | "WRONG_AMOUNT" | "AGENT_COMPLAINT" | "APP_BUG" | "OTHER";
type TicketPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

const VALID_TICKET_STATUSES = new Set(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
const VALID_TICKET_PRIORITIES = new Set(["LOW", "MEDIUM", "HIGH", "URGENT"]);

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

// Admin requests carry X-Admin-Key; everything else needs a user session.
router.use(async (req, res, next) => {
  if (isAdminRequest(req)) { next(); return; }
  return authenticate()(req, res, next);
});

// ── POST /support/tickets ─────────────────────────────────────────────────────
router.post("/tickets", async (req, res, next) => {
  try {
    const {
      agentId,
      category,
      title,
      description,
      linkedTransactionId,
      amount,
    } = req.body as {
      agentId?: string;
      category: TicketCategory;
      title: string;
      description: string;
      linkedTransactionId?: string;
      amount?: number;
    };

    const userId = req.auth?.userId ?? (typeof req.body?.userId === "string" ? req.body.userId : undefined);
    if (!userId || !category || !title || !description) {
      return res.status(400).json({ error: "category, title, description required" });
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
// Users only ever see their own tickets; admins can filter by any userId.
router.get("/tickets", async (req, res, next) => {
  try {
    const { userId, status, priority, limit: lim = "50", offset: off = "0" } = req.query as Record<string, string>;
    const admin = isAdminRequest(req);

    if (status && !VALID_TICKET_STATUSES.has(status)) {
      return res.status(400).json({ error: `status must be one of: ${[...VALID_TICKET_STATUSES].join(", ")}` });
    }
    if (priority && !VALID_TICKET_PRIORITIES.has(priority)) {
      return res.status(400).json({ error: `priority must be one of: ${[...VALID_TICKET_PRIORITIES].join(", ")}` });
    }

    let query = db.select().from(supportTicketsTable).$dynamic();

    const conditions = [];
    const scopedUserId = admin ? userId : req.auth!.userId;
    if (scopedUserId) conditions.push(eq(supportTicketsTable.userId, scopedUserId));
    if (status)   conditions.push(eq(supportTicketsTable.status, status as any));
    if (priority) conditions.push(eq(supportTicketsTable.priority, priority as any));

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const tickets = await query
      .orderBy(desc(supportTicketsTable.createdAt))
      .limit(Math.min(Number(lim) || 50, 200))
      .offset(Number(off) || 0);

    return res.json({ tickets, count: tickets.length });
  } catch (err) { return next(err); }
});

// ── GET /support/tickets/:id ──────────────────────────────────────────────────
router.get("/tickets/:id", async (req, res, next) => {
  try {
    const ticket = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, routeParamString(req, "id")!))
      .limit(1);

    if (!ticket.length) return res.status(404).json({ error: "Ticket not found" });
    if (!isAdminRequest(req) && ticket[0].userId !== req.auth!.userId) {
      return res.status(404).json({ error: "Ticket not found" });
    }
    return res.json({ ticket: ticket[0] });
  } catch (err) { return next(err); }
});

// ── PATCH /support/tickets/:id/resolve ───────────────────────────────────────
router.patch("/tickets/:id/resolve", requirePermission("support.manage"), async (req, res, next) => {
  try {
    const { resolution, assignedTo } = req.body as { resolution: string; assignedTo?: string };
    if (!resolution) return res.status(400).json({ error: "resolution required" });

    const existing = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, routeParamString(req, "id")!))
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
      .where(eq(supportTicketsTable.id, routeParamString(req, "id")!))
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
router.patch("/tickets/:id/status", requirePermission("support.manage"), async (req, res, next) => {
  try {
    const { status, assignedTo } = req.body as { status: string; assignedTo?: string };
    if (!status || !VALID_TICKET_STATUSES.has(status)) {
      return res.status(400).json({ error: `status must be one of: ${[...VALID_TICKET_STATUSES].join(", ")}` });
    }

    const updated = await db
      .update(supportTicketsTable)
      .set({
        status:    status as any,
        assignedTo: assignedTo ?? null,
        updatedAt: new Date(),
      })
      .where(eq(supportTicketsTable.id, routeParamString(req, "id")!))
      .returning();

    if (!updated.length) return res.status(404).json({ error: "Ticket not found" });
    return res.json({ ticket: updated[0] });
  } catch (err) { return next(err); }
});

export default router;
