import { Router } from "express";
import { db } from "@workspace/db";
import { kycRecordsTable, usersTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";

const router = Router();

router.get("/kyc", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const where = status ? eq(kycRecordsTable.status, status as any) : undefined;

    const [records, [{ total }]] = await Promise.all([
      db.select({
        id: kycRecordsTable.id,
        userId: kycRecordsTable.userId,
        documentType: kycRecordsTable.documentType,
        status: kycRecordsTable.status,
        kycLevel: kycRecordsTable.kycLevel,
        rejectionReason: kycRecordsTable.rejectionReason,
        verifiedAt: kycRecordsTable.verifiedAt,
        submittedAt: kycRecordsTable.submittedAt,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
      }).from(kycRecordsTable)
        .leftJoin(usersTable, eq(kycRecordsTable.userId, usersTable.id))
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(sql`${kycRecordsTable.submittedAt} DESC`),
      db.select({ total: count() }).from(kycRecordsTable).where(where),
    ]);

    res.json({
      records: records.map(r => ({
        id: r.id,
        userId: r.userId,
        userName: `${r.firstName || ""} ${r.lastName || ""}`.trim(),
        documentType: r.documentType,
        status: r.status,
        kycLevel: r.kycLevel,
        rejectionReason: r.rejectionReason,
        verifiedAt: r.verifiedAt,
        submittedAt: r.submittedAt,
      })),
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error", message: String(err) });
  }
});

export default router;
