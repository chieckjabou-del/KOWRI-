ALTER TABLE "idempotency_keys" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "mfa_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_secret" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_enabled_at" timestamp;--> statement-breakpoint
-- ── Ledger hardening (AKWÊ financial infrastructure audit) ───────────────────
-- Constraints are NOT VALID so an existing database with historical rows still
-- migrates; every new row is checked. Validate them once history is clean:
--   ALTER TABLE ledger_entries VALIDATE CONSTRAINT ledger_entries_amounts_non_negative;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amounts_non_negative" CHECK ("debit_amount" >= 0 AND "credit_amount" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_single_side" CHECK (("debit_amount" > 0) <> ("credit_amount" > 0)) NOT VALID;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_amounts_valid" CHECK ("amount" > 0 AND "amount_repaid" >= 0 AND "amount_repaid" <= "amount") NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_float_non_negative" CHECK ("float_balance" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "liquidity_transfers" ADD CONSTRAINT "liquidity_transfers_amount_positive" CHECK ("amount" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_amount_positive" CHECK ("amount" > 0) NOT VALID;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_account_currency_idx" ON "ledger_entries" ("account_id", "currency");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "txn_idempotency_idx" ON "transactions" ("idempotency_key");--> statement-breakpoint
-- The journal is append-only: no row of ledger_entries is ever updated or
-- deleted. Corrections are new entries (reversals), never edits.
CREATE OR REPLACE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are append-only (% on %)', TG_OP, OLD.id USING ERRCODE = '23000';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON "ledger_entries";--> statement-breakpoint
CREATE TRIGGER trg_ledger_entries_immutable BEFORE UPDATE OR DELETE ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();--> statement-breakpoint
-- A transaction's financial facts (amount, currency, wallets, type, reference)
-- are frozen at insert; only its lifecycle (status, completed_at, metadata,
-- description) may change, and only along the state machine.
CREATE OR REPLACE FUNCTION transactions_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transactions are never deleted (%)', OLD.id USING ERRCODE = '23000';
  END IF;
  IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.from_wallet_id IS DISTINCT FROM OLD.from_wallet_id OR NEW.to_wallet_id IS DISTINCT FROM OLD.to_wallet_id
     OR NEW.type IS DISTINCT FROM OLD.type OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'transaction % is immutable (only status/completed_at/metadata/description may change)', OLD.id USING ERRCODE = '23000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'pending'    AND NEW.status IN ('processing', 'failed')) OR
      (OLD.status = 'processing' AND NEW.status IN ('completed', 'failed')) OR
      (OLD.status = 'completed'  AND NEW.status = 'reversed')
    ) THEN
      RAISE EXCEPTION 'invalid transaction state transition % -> % (%)', OLD.status, NEW.status, OLD.id USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_transactions_protect ON "transactions";--> statement-breakpoint
CREATE TRIGGER trg_transactions_protect BEFORE UPDATE OR DELETE ON "transactions" FOR EACH ROW EXECUTE FUNCTION transactions_protect();--> statement-breakpoint
-- Double-entry invariant, enforced by the database at COMMIT: for every
-- transaction and currency, debits equal credits; and no wallet account is
-- ever driven below zero by a debit. Application locks are the first line of
-- defence; this is the last one, and it holds even for a bug or a direct write.
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total_debit  numeric;
  total_credit numeric;
  wallet_balance numeric;
BEGIN
  SELECT COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0)
    INTO total_debit, total_credit
    FROM ledger_entries
   WHERE transaction_id = NEW.transaction_id AND currency = NEW.currency;
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED transaction % currency %: debits % <> credits %',
      NEW.transaction_id, NEW.currency, total_debit, total_credit USING ERRCODE = '23000';
  END IF;
  IF NEW.account_type = 'wallet' AND NEW.debit_amount > 0 THEN
    SELECT COALESCE(SUM(credit_amount), 0) - COALESCE(SUM(debit_amount), 0)
      INTO wallet_balance
      FROM ledger_entries
     WHERE account_id = NEW.account_id AND account_type = 'wallet' AND currency = NEW.currency;
    IF wallet_balance < 0 THEN
      RAISE EXCEPTION 'LEDGER_OVERDRAWN wallet % currency % would hold %', NEW.account_id, NEW.currency, wallet_balance USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ledger_assert_balanced ON "ledger_entries";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_ledger_assert_balanced AFTER INSERT ON "ledger_entries" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();--> statement-breakpoint
-- The original seed published USD→XOF 610 with XOF→USD 0.00164 (product 1.0004):
-- a round trip minted 400 XOF per million. Only the known-bad seeded value is
-- corrected; operator-set rates are left alone and reported by
-- GET /fx/rates/consistency.
UPDATE "exchange_rates" SET "rate" = 1.0 / 610, "updated_at" = now() WHERE "id" IN ('fx-xof-usd', 'fx-xaf-usd') AND "rate" = 0.00164;
