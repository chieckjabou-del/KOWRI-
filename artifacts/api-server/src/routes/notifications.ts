import { Router } from "express";
import { db } from "@workspace/db";
import { productNotificationsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../lib/productAuth";

const router = Router();

// GET /api/notifications — all notifications for the auth user (most recent 50)
router.get("/", async (req, res, next) => {
  try {
    const auth = await requireAuth(req.headers.authorization);
    if (!auth) { res.status(401).json({ error: true, message: "Unauthorized" }); return; }

    const notifications = await db
      .select()
      .from(productNotificationsTable)
      .where(eq(productNotificationsTable.userId, auth.userId))
      .orderBy(desc(productNotificationsTable.createdAt))
      .limit(50);

    res.json({
      notifications,
      unreadCount: notifications.filter(n => !n.read).length,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read — mark one notification as read
router.patch("/:id/read", async (req, res, next) => {
  try {
    const auth = await requireAuth(req.headers.authorization);
    if (!auth) { res.status(401).json({ error: true, message: "Unauthorized" }); return; }

    const [updated] = await db
      .update(productNotificationsTable)
      .set({ read: true })
      .where(and(
        eq(productNotificationsTable.id, req.params.id),
        eq(productNotificationsTable.userId, auth.userId),
      ))
      .returning();

    if (!updated) { res.status(404).json({ error: true, message: "Notification not found" }); return; }

    res.json({ success: true, notification: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/read-all — mark all as read
router.patch("/read-all", async (req, res, next) => {
  try {
    const auth = await requireAuth(req.headers.authorization);
    if (!auth) { res.status(401).json({ error: true, message: "Unauthorized" }); return; }

    await db
      .update(productNotificationsTable)
      .set({ read: true })
      .where(and(
        eq(productNotificationsTable.userId, auth.userId),
        eq(productNotificationsTable.read, false),
      ));

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
