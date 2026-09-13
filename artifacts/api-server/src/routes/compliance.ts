import { Router } from "express";
import { db } from "@workspace/db";
import { kycRecordsTable, usersTable } from "@workspace/db";
import { eq, sql, count, and } from "drizzle-orm";
import { requireAdmin, gateWrites } from "../middleware/auth";
import { validateQueryParams, VALID_KYC_STATUSES } from "../middleware/validate";
import { routeParamString } from "../lib/routeParams";
import { audit } from "../lib/auditLogger";
import { eventBus } from "../lib/eventBus";
import { decryptField } from "../lib/fieldCrypto";

const router = Router();

// KYC records carry identity documents: compliance officers only.
router.use(requireAdmin);
router.use(gateWrites("kyc.review"));

router.get("/kyc", validateQueryParams({ status: VALID_KYC_STATUSES }), async (req, res, next) => {
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

    return res.json({
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
    return next(err);
  }
});

router.get("/kyc/:recordId", async (req, res, next) => {
  try {
    const recordId = routeParamString(req, "recordId")!;
    const [record] = await db.select().from(kycRecordsTable).where(eq(kycRecordsTable.id, recordId));
    if (!record) return res.status(404).json({ error: "KYC record not found" });
    // Documents are decrypted here only, for the reviewer; every other read omits them.
    await audit({ action: "kyc.documents_viewed", entity: "kyc_record", entityId: recordId, actor: req.admin?.email ?? "legacy-key", metadata: { userId: record.userId } });
    return res.json({ record: {
      ...record,
      documentFront:  decryptField(record.documentFront),
      selfie:         decryptField(record.selfie),
      proofOfAddress: decryptField(record.proofOfAddress),
      secondDocument: decryptField(record.secondDocument),
    } });
  } catch (err) {
    return next(err);
  }
});

// PATCH /compliance/kyc/:recordId — { decision: "approve" | "reject", rejectionReason?, reviewer? }
// Approval is the only path that raises a user's KYC level (and activates a pending_kyc account).
router.patch("/kyc/:recordId", async (req, res, next) => {
  try {
    const recordId = routeParamString(req, "recordId")!;
    const { decision, rejectionReason, reviewer = "admin" } = req.body ?? {};
    if (decision !== "approve" && decision !== "reject") {
      return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
    }
    if (decision === "reject" && (typeof rejectionReason !== "string" || !rejectionReason.trim())) {
      return res.status(400).json({ error: "rejectionReason is required when rejecting" });
    }

    const [record] = await db.select().from(kycRecordsTable).where(eq(kycRecordsTable.id, recordId));
    if (!record) return res.status(404).json({ error: "KYC record not found" });
    if (record.status !== "pending") {
      return res.status(409).json({ error: `KYC record already ${record.status}` });
    }

    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const [updated] = await tx.update(kycRecordsTable)
        .set(decision === "approve"
          ? { status: "verified", verifiedAt: now, rejectionReason: null }
          : { status: "rejected", rejectionReason: String(rejectionReason).trim() })
        .where(and(eq(kycRecordsTable.id, recordId), eq(kycRecordsTable.status, "pending")))
        .returning();
      if (!updated) throw new Error("KYC record was reviewed concurrently");

      let user: typeof usersTable.$inferSelect | undefined;
      if (decision === "approve") {
        const [current] = await tx.select().from(usersTable).where(eq(usersTable.id, record.userId));
        if (!current) throw new Error("User not found");
        [user] = await tx.update(usersTable)
          .set({
            kycLevel: Math.max(current.kycLevel, record.kycLevel),
            status: current.status === "pending_kyc" ? "active" : current.status,
            updatedAt: now,
          })
          .where(eq(usersTable.id, record.userId))
          .returning();
        if (current.status === "pending_kyc") {
          await audit({ action: "user.status_changed", entity: "user", entityId: record.userId, actor: String(reviewer),
            metadata: { from: "pending_kyc", to: "active", trigger: "kyc_approved", recordId } });
        }
      }
      return { updated, user };
    });

    await audit({
      action: "kyc.reviewed",
      entity: "kyc_record",
      entityId: recordId,
      actor: String(reviewer),
      metadata: { userId: record.userId, decision, kycLevel: record.kycLevel, rejectionReason: rejectionReason ?? null },
    });
    await eventBus.publish(decision === "approve" ? "kyc.verified" : "kyc.rejected", {
      userId: record.userId, recordId, kycLevel: record.kycLevel, rejectionReason: rejectionReason ?? null,
    });

    const { documentFront: _df, selfie: _sf, proofOfAddress: _pa, secondDocument: _sd, ...reviewed } = result.updated;
    return res.json({
      record: reviewed,
      user: result.user ? { id: result.user.id, status: result.user.status, kycLevel: result.user.kycLevel } : undefined,
    });
  } catch (err: any) {
    if (err?.message === "KYC record was reviewed concurrently") {
      return res.status(409).json({ error: err.message });
    }
    return next(err);
  }
});

export default router;
