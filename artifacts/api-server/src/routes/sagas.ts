import { Router } from "express";
import { db } from "@workspace/db";
import { sagasTable } from "@workspace/db";
import { eq, desc, count, sql } from "drizzle-orm";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const query = db.select().from(sagasTable).orderBy(desc(sagasTable.createdAt)).limit(limit).offset(offset);
    const countQuery = db.select({ total: count() }).from(sagasTable);

    if (status) {
      query.where(eq(sagasTable.status, status));
      countQuery.where(eq(sagasTable.status, status));
    }

    const [sagas, [{ total }]] = await Promise.all([query, countQuery]);
    res.json({ sagas, pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) } });
  } catch (err) { next(err); }
});

router.get("/stats", async (req, res, next) => {
  try {
    const rows = await db
      .select({ status: sagasTable.status, count: count() })
      .from(sagasTable)
      .groupBy(sagasTable.status);

    const stats = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    res.json({ stats, total });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [saga] = await db.select().from(sagasTable).where(eq(sagasTable.id, req.params.id));
    if (!saga) { res.status(404).json({ error: true, message: "Saga not found" }); return; }
    res.json(saga);
  } catch (err) { next(err); }
});

export default router;
