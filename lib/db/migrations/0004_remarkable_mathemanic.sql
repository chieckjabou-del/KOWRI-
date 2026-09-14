CREATE TABLE "cash_in_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"admin_id" text NOT NULL,
	"admin_email" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"ip_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_in_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text NOT NULL,
	"amount_reference" numeric(20, 4) NOT NULL,
	"reference" text NOT NULL,
	"source" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'PENDING_APPROVAL' NOT NULL,
	"approvals_required" integer DEFAULT 1 NOT NULL,
	"initiated_by" text NOT NULL,
	"initiated_by_email" text NOT NULL,
	"initiated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"second_approved_by" text,
	"second_approved_at" timestamp,
	"closed_by" text,
	"closed_at" timestamp,
	"close_reason" text,
	"transaction_id" text,
	"executed_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cash_in_decisions_request_idx" ON "cash_in_decisions" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_in_reference_uidx" ON "cash_in_requests" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_in_transaction_uidx" ON "cash_in_requests" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "cash_in_status_idx" ON "cash_in_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cash_in_initiator_idx" ON "cash_in_requests" USING btree ("initiated_by","initiated_at");--> statement-breakpoint
CREATE INDEX "cash_in_wallet_idx" ON "cash_in_requests" USING btree ("wallet_id","initiated_at");--> statement-breakpoint
-- ── P0 financial control gate ────────────────────────────────────────────────
-- 1. cash_in_requests: the request row is the authority for money creation.
--    Financial facts are frozen at insert, the state machine is enforced,
--    the four-eyes rule (approver ≠ initiator, second approver ≠ both) is a
--    database rule, an EXECUTED row must carry its approvals and its
--    transaction, and terminal rows never change. Rows are never deleted.
CREATE OR REPLACE FUNCTION cash_in_requests_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CASH_IN_IMMUTABLE cash_in_requests are never deleted (%)', OLD.id USING ERRCODE = '23000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' OR NEW.approved_by IS NOT NULL OR NEW.second_approved_by IS NOT NULL
       OR NEW.transaction_id IS NOT NULL OR NEW.executed_at IS NOT NULL OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'CASH_IN_INVALID_INSERT a cash-in request is born PENDING_APPROVAL without approvals (%)', NEW.id USING ERRCODE = '23000';
    END IF;
    IF NEW.amount <= 0 OR NEW.amount_reference <= 0 OR NEW.approvals_required NOT IN (1, 2) OR NEW.expires_at <= NEW.initiated_at THEN
      RAISE EXCEPTION 'CASH_IN_INVALID_INSERT amount, approvals_required or expiry out of range (%)', NEW.id USING ERRCODE = '23000';
    END IF;
    IF NEW.initiated_by = 'legacy-key' OR NEW.initiated_by = '' THEN
      RAISE EXCEPTION 'CASH_IN_INVALID_INSERT initiator must be a named operator (%)', NEW.id USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.status IN ('EXECUTED', 'REJECTED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'CASH_IN_CLOSED request % is % and can no longer change', OLD.id, OLD.status USING ERRCODE = '23000';
  END IF;
  IF NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.amount_reference IS DISTINCT FROM OLD.amount_reference OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.approvals_required IS DISTINCT FROM OLD.approvals_required
     OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by OR NEW.initiated_by_email IS DISTINCT FROM OLD.initiated_by_email
     OR NEW.initiated_at IS DISTINCT FROM OLD.initiated_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CASH_IN_IMMUTABLE the financial facts of request % cannot change after initiation', OLD.id USING ERRCODE = '23000';
  END IF;
  IF (OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     OR (OLD.second_approved_by IS NOT NULL AND NEW.second_approved_by IS DISTINCT FROM OLD.second_approved_by) THEN
    RAISE EXCEPTION 'CASH_IN_IMMUTABLE an approval on request % cannot be rewritten', OLD.id USING ERRCODE = '23000';
  END IF;
  IF NEW.approved_by IS NOT NULL AND NEW.approved_by = NEW.initiated_by THEN
    RAISE EXCEPTION 'CASH_IN_SELF_APPROVAL request % cannot be approved by its initiator', OLD.id USING ERRCODE = '23000';
  END IF;
  IF NEW.second_approved_by IS NOT NULL AND (NEW.second_approved_by = NEW.initiated_by OR NEW.second_approved_by = NEW.approved_by) THEN
    RAISE EXCEPTION 'CASH_IN_SELF_APPROVAL request % needs a second approver distinct from initiator and first approver', OLD.id USING ERRCODE = '23000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'EXECUTED', 'REJECTED', 'CANCELLED', 'EXPIRED')) OR
      (OLD.status = 'APPROVED'         AND NEW.status IN ('EXECUTED', 'REJECTED', 'CANCELLED', 'EXPIRED'))
    ) THEN
      RAISE EXCEPTION 'CASH_IN_INVALID_TRANSITION % -> % (%)', OLD.status, NEW.status, OLD.id USING ERRCODE = '23000';
    END IF;
  END IF;
  IF NEW.status = 'APPROVED' AND (NEW.approved_by IS NULL OR NEW.approvals_required < 2) THEN
    RAISE EXCEPTION 'CASH_IN_INVALID_TRANSITION APPROVED needs a first approval on a two-signature request (%)', OLD.id USING ERRCODE = '23000';
  END IF;
  IF NEW.status = 'EXECUTED' THEN
    IF NEW.approved_by IS NULL OR (NEW.approvals_required >= 2 AND NEW.second_approved_by IS NULL) THEN
      RAISE EXCEPTION 'CASH_IN_EXECUTED_WITHOUT_APPROVAL request % lacks the required approvals', OLD.id USING ERRCODE = '23000';
    END IF;
    IF NEW.transaction_id IS NULL OR NEW.executed_at IS NULL THEN
      RAISE EXCEPTION 'CASH_IN_EXECUTED_WITHOUT_TRANSACTION request % has no ledger transaction', OLD.id USING ERRCODE = '23000';
    END IF;
    -- The transaction must already exist in this database transaction and be
    -- the deposit of this very request: no EXECUTED row can point at nothing.
    IF NOT EXISTS (
      SELECT 1 FROM transactions t
       WHERE t.id = NEW.transaction_id AND t.type = 'deposit' AND t.to_wallet_id = NEW.wallet_id
         AND t.amount = NEW.amount AND t.currency = NEW.currency
         AND t.metadata->>'authority' = 'cash_in_request' AND t.metadata->>'cashInRequestId' = NEW.id
    ) THEN
      RAISE EXCEPTION 'CASH_IN_EXECUTED_WITHOUT_TRANSACTION request % names a transaction that is not its own deposit', OLD.id USING ERRCODE = '23000';
    END IF;
    IF NEW.expires_at < now() THEN
      RAISE EXCEPTION 'CASH_IN_EXPIRED request % expired at % and cannot be executed', OLD.id, NEW.expires_at USING ERRCODE = '23000';
    END IF;
  ELSIF NEW.transaction_id IS NOT NULL OR NEW.executed_at IS NOT NULL THEN
    RAISE EXCEPTION 'CASH_IN_INVALID_TRANSITION only an EXECUTED request carries a transaction (%)', OLD.id USING ERRCODE = '23000';
  END IF;
  IF NEW.status IN ('REJECTED', 'CANCELLED', 'EXPIRED') AND (NEW.closed_by IS NULL OR NEW.closed_at IS NULL) THEN
    RAISE EXCEPTION 'CASH_IN_INVALID_TRANSITION a closed request records who closed it (%)', OLD.id USING ERRCODE = '23000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_cash_in_requests_protect ON "cash_in_requests";--> statement-breakpoint
CREATE TRIGGER trg_cash_in_requests_protect BEFORE INSERT OR UPDATE OR DELETE ON "cash_in_requests" FOR EACH ROW EXECUTE FUNCTION cash_in_requests_protect();--> statement-breakpoint
-- 2. Decision trail and audit journal are append-only.
CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY % is append-only (% on %)', TG_TABLE_NAME, TG_OP, OLD.id USING ERRCODE = '23000';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_cash_in_decisions_append_only ON "cash_in_decisions";--> statement-breakpoint
CREATE TRIGGER trg_cash_in_decisions_append_only BEFORE UPDATE OR DELETE ON "cash_in_decisions" FOR EACH ROW EXECUTE FUNCTION append_only_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON "audit_logs";--> statement-breakpoint
CREATE TRIGGER trg_audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION append_only_guard();--> statement-breakpoint
-- 3. Every deposit transaction must name its authority, checked at COMMIT:
--    'cash_in_request'  → the referenced request is EXECUTED, points back to this
--                         transaction and carries the same wallet, amount, currency;
--    'savings_yield'    → interest accrual on a locked savings plan (platform cost);
--    'treasury_seed', 'demo_seed' → non-production capital and demo data
--                         (reported as anomalies by the reconciliation in production);
--    'reversal'         → mirror of an earlier deposit (money destroyed, not created).
--    Anything else — including no authority at all — is refused, whatever wrote it.
CREATE OR REPLACE FUNCTION transactions_deposit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  authority text;
  req cash_in_requests%ROWTYPE;
  original transactions%ROWTYPE;
BEGIN
  IF NEW.type <> 'deposit' THEN RETURN NULL; END IF;
  authority := NEW.metadata->>'authority';
  IF authority IS NULL THEN
    RAISE EXCEPTION 'DEPOSIT_WITHOUT_AUTHORITY transaction % creates money without a named authority', NEW.id USING ERRCODE = '23000';
  END IF;
  IF authority = 'cash_in_request' THEN
    SELECT * INTO req FROM cash_in_requests WHERE id = NEW.metadata->>'cashInRequestId';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DEPOSIT_UNKNOWN_CASH_IN_REQUEST transaction % references no cash-in request', NEW.id USING ERRCODE = '23000';
    END IF;
    IF req.status <> 'EXECUTED' OR req.transaction_id IS DISTINCT FROM NEW.id OR req.wallet_id IS DISTINCT FROM NEW.to_wallet_id
       OR req.amount <> NEW.amount OR req.currency <> NEW.currency THEN
      RAISE EXCEPTION 'DEPOSIT_CASH_IN_MISMATCH transaction % does not match cash-in request % (status %)', NEW.id, req.id, req.status USING ERRCODE = '23000';
    END IF;
  ELSIF authority = 'reversal' THEN
    SELECT * INTO original FROM transactions WHERE id = NEW.metadata->>'reversalOf';
    IF NOT FOUND OR original.type <> 'deposit' OR original.status <> 'reversed' OR original.amount <> NEW.amount OR original.to_wallet_id IS DISTINCT FROM NEW.from_wallet_id THEN
      RAISE EXCEPTION 'DEPOSIT_REVERSAL_MISMATCH transaction % is not the mirror of a reversed deposit', NEW.id USING ERRCODE = '23000';
    END IF;
  ELSIF authority NOT IN ('savings_yield', 'treasury_seed', 'demo_seed') THEN
    RAISE EXCEPTION 'DEPOSIT_UNKNOWN_AUTHORITY transaction % names an unknown authority %', NEW.id, authority USING ERRCODE = '23000';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_transactions_deposit_authority ON "transactions";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_transactions_deposit_authority AFTER INSERT ON "transactions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transactions_deposit_authority();--> statement-breakpoint
-- 4. platform_float can only be debited (money created) by a deposit transaction
--    that carries a creating authority. A transfer or any hand-written row that
--    draws on the float is refused at COMMIT, so no ledger entry can mint money
--    outside the cash-in authority above.
CREATE OR REPLACE FUNCTION ledger_float_debit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t transactions%ROWTYPE;
BEGIN
  IF NEW.account_id <> 'platform_float' OR NEW.debit_amount <= 0 THEN RETURN NULL; END IF;
  SELECT * INTO t FROM transactions WHERE id = NEW.transaction_id;
  IF NOT FOUND OR t.type <> 'deposit' OR COALESCE(t.metadata->>'authority', '') NOT IN ('cash_in_request', 'savings_yield', 'treasury_seed', 'demo_seed') THEN
    RAISE EXCEPTION 'FLOAT_DEBIT_WITHOUT_AUTHORITY ledger entry % draws on platform_float outside an authorised deposit', NEW.id USING ERRCODE = '23000';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ledger_float_debit_authority ON "ledger_entries";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_ledger_float_debit_authority AFTER INSERT ON "ledger_entries" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_float_debit_authority();--> statement-breakpoint
-- 5. Historical deposits written before this gate (demo seed, direct
--    /wallets/:id/deposit, savings yield) are labelled so the reconciliation
--    can account for them; nothing is deleted or re-valued.
UPDATE "transactions" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || '{"authority": "legacy_pre_gate"}'::jsonb
 WHERE "type" = 'deposit' AND ("metadata" IS NULL OR "metadata"->>'authority' IS NULL);
--> statement-breakpoint
-- 6. Row triggers do not fire on TRUNCATE: without this, a single statement
--    could empty the journal, the transactions or the audit trail. Statement
--    triggers close that door on every append-only or immutable table.
CREATE OR REPLACE FUNCTION no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY % cannot be truncated', TG_TABLE_NAME USING ERRCODE = '23000';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ledger_entries_no_truncate ON "ledger_entries";--> statement-breakpoint
CREATE TRIGGER trg_ledger_entries_no_truncate BEFORE TRUNCATE ON "ledger_entries" FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_transactions_no_truncate ON "transactions";--> statement-breakpoint
CREATE TRIGGER trg_transactions_no_truncate BEFORE TRUNCATE ON "transactions" FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON "audit_logs";--> statement-breakpoint
CREATE TRIGGER trg_audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_cash_in_requests_no_truncate ON "cash_in_requests";--> statement-breakpoint
CREATE TRIGGER trg_cash_in_requests_no_truncate BEFORE TRUNCATE ON "cash_in_requests" FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_cash_in_decisions_no_truncate ON "cash_in_decisions";--> statement-breakpoint
CREATE TRIGGER trg_cash_in_decisions_no_truncate BEFORE TRUNCATE ON "cash_in_decisions" FOR EACH STATEMENT EXECUTE FUNCTION no_truncate();
