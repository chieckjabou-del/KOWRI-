// ── Ledger Balance Seeder ─────────────────────────────────────────────────────
//
// Ensures the ledger_balance_summary singleton row (id = 1) exists before the
// autopilot begins reading from it.
//
// Strategy:
//   1. Attempt a fast read of the singleton row.
//   2. If the row already exists, do nothing — the trigger keeps it current.
//   3. If the row is missing, compute the live totals from ledger_entries
//      (one-time full scan) and INSERT the seed row.
//
// This runs ONCE at server startup.  After the first successful seed the trigger
// on ledger_entries maintains the row on every write — no further scans needed.
//
// ROLLBACK: remove seedLedgerBalanceSummary() call from index.ts; delete this file.

import { db }  from "@workspace/db";
import { sql } from "drizzle-orm";

export async function seedLedgerBalanceSummary(): Promise<void> {
  // Step 1 — check if the summary row already exists.
  const existing = await db.execute<{ id: number }>(sql`
    SELECT id FROM ledger_balance_summary WHERE id = 1 LIMIT 1
  `);

  if ((existing as any).rows?.length > 0) {
    console.info("[LedgerSeeder] ledger_balance_summary row already present — skipping seed");
    return;
  }

  // Step 2 — first run: compute current totals and seed the row.
  console.info("[LedgerSeeder] seeding ledger_balance_summary from live ledger_entries …");

  await db.execute(sql`
    INSERT INTO ledger_balance_summary (id, total_credit, total_debit, updated_at)
    SELECT
      1,
      COALESCE(SUM(CAST(credit_amount AS NUMERIC)), 0),
      COALESCE(SUM(CAST(debit_amount  AS NUMERIC)), 0),
      NOW()
    FROM ledger_entries
    ON CONFLICT (id) DO NOTHING
  `);

  console.info("[LedgerSeeder] seed complete");
}

// ── Trigger installation ──────────────────────────────────────────────────────
// Creates (or replaces) the PostgreSQL trigger that keeps ledger_balance_summary
// in sync with every INSERT / UPDATE / DELETE on ledger_entries.
//
// Safe to call on every startup — CREATE OR REPLACE is idempotent.

export async function installLedgerTrigger(): Promise<void> {
  // Trigger function — one UPDATE per row change, no full scans.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION maintain_ledger_balance_summary()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      -- Ensure the singleton row exists (handles edge cases after a hard reset).
      INSERT INTO ledger_balance_summary (id, total_credit, total_debit, updated_at)
      VALUES (1, 0, 0, NOW())
      ON CONFLICT (id) DO NOTHING;

      IF TG_OP = 'INSERT' THEN
        UPDATE ledger_balance_summary
        SET
          total_credit = total_credit + COALESCE(NEW.credit_amount::NUMERIC, 0),
          total_debit  = total_debit  + COALESCE(NEW.debit_amount::NUMERIC,  0),
          updated_at   = NOW()
        WHERE id = 1;

      ELSIF TG_OP = 'UPDATE' THEN
        UPDATE ledger_balance_summary
        SET
          total_credit = total_credit
                         + COALESCE(NEW.credit_amount::NUMERIC, 0)
                         - COALESCE(OLD.credit_amount::NUMERIC, 0),
          total_debit  = total_debit
                         + COALESCE(NEW.debit_amount::NUMERIC,  0)
                         - COALESCE(OLD.debit_amount::NUMERIC,  0),
          updated_at   = NOW()
        WHERE id = 1;

      ELSIF TG_OP = 'DELETE' THEN
        UPDATE ledger_balance_summary
        SET
          total_credit = total_credit - COALESCE(OLD.credit_amount::NUMERIC, 0),
          total_debit  = total_debit  - COALESCE(OLD.debit_amount::NUMERIC,  0),
          updated_at   = NOW()
        WHERE id = 1;
      END IF;

      RETURN NULL;
    END;
    $$
  `);

  // Drop and recreate so the trigger always points to the latest function body.
  await db.execute(sql`
    DROP TRIGGER IF EXISTS trg_maintain_ledger_balance ON ledger_entries
  `);

  await db.execute(sql`
    CREATE TRIGGER trg_maintain_ledger_balance
    AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION maintain_ledger_balance_summary()
  `);

  console.info("[LedgerSeeder] trigger trg_maintain_ledger_balance installed");
}
