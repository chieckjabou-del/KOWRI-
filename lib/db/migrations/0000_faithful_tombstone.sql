CREATE TYPE "public"."document_type" AS ENUM('national_id', 'passport', 'drivers_license');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('pending', 'verified', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'pending_kyc');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('active', 'frozen', 'closed');--> statement-breakpoint
CREATE TYPE "public"."wallet_type" AS ENUM('personal', 'merchant', 'savings', 'tontine');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('deposit', 'transfer', 'withdrawal', 'loan_disbursement', 'loan_repayment', 'subscription', 'tontine_contribution', 'tontine_payout', 'merchant_payment');--> statement-breakpoint
CREATE TYPE "public"."currency_mode" AS ENUM('single', 'multi');--> statement-breakpoint
CREATE TYPE "public"."tontine_frequency" AS ENUM('weekly', 'biweekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."tontine_status" AS ENUM('active', 'completed', 'pending', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."tontine_type" AS ENUM('classic', 'investment', 'project', 'solidarity', 'business', 'diaspora', 'yield', 'growth', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."credit_tier" AS ENUM('bronze', 'silver', 'gold', 'platinum');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('pending', 'approved', 'disbursed', 'repaid', 'defaulted');--> statement-breakpoint
CREATE TYPE "public"."merchant_status" AS ENUM('active', 'suspended', 'pending_approval');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('ACTIVE', 'SUSPENDED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."agent_type" AS ENUM('AGENT', 'SUPER_AGENT', 'MASTER');--> statement-breakpoint
CREATE TYPE "public"."alert_level" AS ENUM('WARNING', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."alert_type" AS ENUM('LOW_CASH', 'LOW_FLOAT', 'ZONE_TENSION', 'SURPLUS');--> statement-breakpoint
CREATE TYPE "public"."anomaly_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."anomaly_type" AS ENUM('CASH_MISMATCH', 'RAPID_WITHDRAWALS', 'LARGE_ROUND_AMOUNTS', 'CLIENT_COMPLAINT', 'RECONCILIATION_FAIL', 'COLLUSION_PATTERN');--> statement-breakpoint
CREATE TYPE "public"."agent_badge" AS ENUM('FIRST_100_CLIENTS', 'VOLUME_5M', 'VOLUME_20M', 'ZERO_ANOMALIES_30D', 'TOP_ZONE_AGENT', 'TRUSTED_VETERAN', 'TONTINE_CHAMPION');--> statement-breakpoint
CREATE TYPE "public"."liquidity_status" AS ENUM('PENDING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."liquidity_type" AS ENUM('CASH', 'FLOAT', 'REBALANCE');--> statement-breakpoint
CREATE TYPE "public"."purchase_goal_status" AS ENUM('open', 'funded', 'released', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."recon_status" AS ENUM('PENDING', 'MATCHED', 'MISMATCH', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."release_condition" AS ENUM('goal_reached', 'date_reached', 'vote');--> statement-breakpoint
CREATE TYPE "public"."solidarity_claim_status" AS ENUM('pending_admin', 'approved', 'rejected', 'disbursed');--> statement-breakpoint
CREATE TYPE "public"."solidarity_claim_urgency" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."strategy_target_status" AS ENUM('funded', 'active', 'completed', 'defaulted');--> statement-breakpoint
CREATE TYPE "public"."ticket_category" AS ENUM('TRANSACTION_ISSUE', 'ACCOUNT_LOCKED', 'WRONG_AMOUNT', 'AGENT_COMPLAINT', 'APP_BUG', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."trust_level" AS ENUM('TRUSTED', 'WATCH', 'FLAGGED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."fee_operation_type" AS ENUM('cashout', 'tontine_payout', 'merchant_payment', 'diaspora_transfer', 'loan_disbursement');--> statement-breakpoint
CREATE TYPE "public"."fee_user_tier" AS ENUM('all', 'bronze', 'silver', 'gold', 'platinum');--> statement-breakpoint
CREATE TABLE "kyc_records" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_type" "document_type" NOT NULL,
	"status" "kyc_status" DEFAULT 'pending' NOT NULL,
	"kyc_level" integer DEFAULT 1 NOT NULL,
	"document_number" text,
	"full_name" text,
	"date_of_birth" text,
	"document_front" text,
	"selfie" text,
	"proof_of_address" text,
	"second_document" text,
	"rejection_reason" text,
	"verified_at" timestamp,
	"submitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"status" "user_status" DEFAULT 'pending_kyc' NOT NULL,
	"kyc_level" integer DEFAULT 0 NOT NULL,
	"country" text NOT NULL,
	"pin_hash" text NOT NULL,
	"credit_score" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"avatar_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"balance" numeric(20, 4) DEFAULT '0' NOT NULL,
	"available_balance" numeric(20, 4) DEFAULT '0' NOT NULL,
	"status" "wallet_status" DEFAULT 'active' NOT NULL,
	"wallet_type" "wallet_type" DEFAULT 'personal' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_balance_non_negative" CHECK ("wallets"."balance" >= 0),
	CONSTRAINT "wallets_available_balance_non_negative" CHECK ("wallets"."available_balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"account_id" text NOT NULL,
	"account_type" text NOT NULL,
	"debit_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"credit_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"event_type" text NOT NULL,
	"description" text,
	"entry_type" text,
	"wallet_id" text,
	"reference" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"from_wallet_id" text,
	"to_wallet_id" text,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"type" "transaction_type" NOT NULL,
	"status" "transaction_status" DEFAULT 'pending' NOT NULL,
	"reference" text NOT NULL,
	"description" text,
	"metadata" jsonb,
	"idempotency_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "transactions_reference_unique" UNIQUE("reference"),
	CONSTRAINT "transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "tontine_members" (
	"id" text PRIMARY KEY NOT NULL,
	"tontine_id" text NOT NULL,
	"user_id" text NOT NULL,
	"payout_order" integer NOT NULL,
	"has_received_payout" integer DEFAULT 0 NOT NULL,
	"contributions_count" integer DEFAULT 0 NOT NULL,
	"personal_contribution" numeric(20, 4),
	"yield_owed" numeric(20, 4) DEFAULT '0' NOT NULL,
	"yield_paid" numeric(20, 4) DEFAULT '0' NOT NULL,
	"received_payout_at" timestamp,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"missed_contributions" integer DEFAULT 0 NOT NULL,
	"member_status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tontines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"contribution_amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"frequency" "tontine_frequency" NOT NULL,
	"max_members" integer NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"current_round" integer DEFAULT 0 NOT NULL,
	"total_rounds" integer NOT NULL,
	"status" "tontine_status" DEFAULT 'pending' NOT NULL,
	"tontine_type" "tontine_type" DEFAULT 'classic' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_multi_amount" boolean DEFAULT false NOT NULL,
	"goal_description" text,
	"goal_amount" numeric(20, 4),
	"merchant_id" text,
	"investment_pool_id" text,
	"currency_mode" "currency_mode" DEFAULT 'single' NOT NULL,
	"yield_rate" numeric(5, 2),
	"yield_pool_balance" numeric(20, 4) DEFAULT '0' NOT NULL,
	"growth_rate" numeric(5, 2),
	"hybrid_config" jsonb,
	"solidarity_reserve" numeric(20, 4) DEFAULT '0' NOT NULL,
	"strategy_mode" boolean DEFAULT false NOT NULL,
	"strategy_zone" text,
	"strategy_objective" text,
	"network_wallets" jsonb,
	"admin_user_id" text NOT NULL,
	"wallet_id" text,
	"next_payout_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"score" integer DEFAULT 300 NOT NULL,
	"tier" "credit_tier" DEFAULT 'bronze' NOT NULL,
	"max_loan_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"interest_rate" numeric(5, 2) DEFAULT '15' NOT NULL,
	"payment_history" integer DEFAULT 0 NOT NULL,
	"savings_regularity" integer DEFAULT 0 NOT NULL,
	"transaction_volume" integer DEFAULT 0 NOT NULL,
	"tontine_participation" integer DEFAULT 0 NOT NULL,
	"network_score" integer DEFAULT 0 NOT NULL,
	"last_updated" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_scores_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"interest_rate" numeric(5, 2) NOT NULL,
	"term_days" integer NOT NULL,
	"status" "loan_status" DEFAULT 'pending' NOT NULL,
	"amount_repaid" numeric(20, 4) DEFAULT '0' NOT NULL,
	"purpose" text,
	"due_date" timestamp,
	"disbursed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"business_name" text NOT NULL,
	"business_type" text NOT NULL,
	"status" "merchant_status" DEFAULT 'pending_approval' NOT NULL,
	"wallet_id" text NOT NULL,
	"api_key" text,
	"country" text NOT NULL,
	"total_revenue" numeric(20, 4) DEFAULT '0' NOT NULL,
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"priority" smallint DEFAULT 5 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"process_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"id" text PRIMARY KEY NOT NULL,
	"outbox_event_id" text NOT NULL,
	"topic" text NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_outbox_event_id_unique" UNIQUE("outbox_event_id")
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"base_currency" text NOT NULL,
	"target_currency" text NOT NULL,
	"rate" numeric(20, 8) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"alert_type" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"metadata" jsonb,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sagas" (
	"id" text PRIMARY KEY NOT NULL,
	"saga_type" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"partner" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"settled_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "wallet_limits" (
	"wallet_id" text PRIMARY KEY NOT NULL,
	"max_tx_per_minute" integer DEFAULT 10 NOT NULL,
	"max_hourly_volume" numeric(20, 4) DEFAULT '5000000' NOT NULL,
	"max_daily_volume" numeric(20, 4) DEFAULT '20000000' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"url" text NOT NULL,
	"event_type" text NOT NULL,
	"secret" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aml_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"transaction_id" text,
	"reason" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"metadata" jsonb,
	"reviewed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"case_type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"connector_type" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_ping_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rate_history" (
	"id" text PRIMARY KEY NOT NULL,
	"base_currency" text NOT NULL,
	"target_currency" text NOT NULL,
	"rate" numeric(20, 8) NOT NULL,
	"source" text DEFAULT 'internal' NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_archive" (
	"id" text PRIMARY KEY NOT NULL,
	"original_tx_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text NOT NULL,
	"balance_after" numeric(20, 4),
	"archive_year" integer NOT NULL,
	"archived_at" timestamp DEFAULT now() NOT NULL,
	"original_created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ledger_shards" (
	"id" text PRIMARY KEY NOT NULL,
	"shard_key" text NOT NULL,
	"shard_index" integer NOT NULL,
	"wallet_id_range_start" text,
	"wallet_id_range_end" text,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_shards_shard_key_unique" UNIQUE("shard_key")
);
--> statement-breakpoint
CREATE TABLE "message_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"consumer_group" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"route_type" text NOT NULL,
	"processor" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"service" text NOT NULL,
	"operation" text NOT NULL,
	"duration_ms" integer,
	"status" text DEFAULT 'ok' NOT NULL,
	"metadata" jsonb,
	"started_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clearing_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_ref" text NOT NULL,
	"institution_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"submitted_at" timestamp,
	"settled_at" timestamp,
	"failed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "clearing_batches_batch_ref_unique" UNIQUE("batch_ref")
);
--> statement-breakpoint
CREATE TABLE "clearing_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"from_account_id" text NOT NULL,
	"to_account_id" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_ref" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fraud_network_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"edge_type" text DEFAULT 'transfer' NOT NULL,
	"weight" numeric(10, 4) DEFAULT '1' NOT NULL,
	"transaction_count" integer DEFAULT 1 NOT NULL,
	"total_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fraud_network_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"node_type" text DEFAULT 'wallet' NOT NULL,
	"risk_score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"flagged_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fraud_network_nodes_wallet_id_unique" UNIQUE("wallet_id")
);
--> statement-breakpoint
CREATE TABLE "fraud_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"factors" jsonb,
	"model_version" text DEFAULT 'v1' NOT NULL,
	"calculated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_liquidity_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"pool_size" numeric(20, 4) DEFAULT '0' NOT NULL,
	"available" numeric(20, 4) DEFAULT '0' NOT NULL,
	"reserved" numeric(20, 4) DEFAULT '0' NOT NULL,
	"utilization_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"min_threshold" numeric(20, 4) DEFAULT '0' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fx_liquidity_pools_currency_unique" UNIQUE("currency")
);
--> statement-breakpoint
CREATE TABLE "fx_liquidity_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"base_currency" text NOT NULL,
	"target_currency" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"slippage_bps" numeric(8, 2) DEFAULT '0' NOT NULL,
	"exposure" numeric(20, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulatory_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"report_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"format" text DEFAULT 'json' NOT NULL,
	"period_start" timestamp,
	"period_end" timestamp,
	"record_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"generated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "report_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"entry_type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "developer_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"developer_id" text NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_tier" text DEFAULT 'free' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"daily_limit" integer DEFAULT 1000 NOT NULL,
	"monthly_limit" integer DEFAULT 10000 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "developer_usage_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"status_code" integer DEFAULT 200 NOT NULL,
	"response_ms" integer DEFAULT 0 NOT NULL,
	"ip_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"invoice_number" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"customer_phone" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal" numeric(20, 4) DEFAULT '0' NOT NULL,
	"tax" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"due_at" timestamp,
	"paid_at" timestamp,
	"transaction_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "product_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_payment_links" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"amount" numeric(20, 4),
	"currency" text DEFAULT 'XOF' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"paid_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_payment_links_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_qr_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"entity_type" text DEFAULT 'wallet' NOT NULL,
	"amount" numeric(20, 4),
	"currency" text DEFAULT 'XOF' NOT NULL,
	"label" text,
	"qr_data" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"max_uses" integer,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"type" text DEFAULT 'wallet' NOT NULL,
	"device_id" text,
	"ip_address" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "agent_achievements" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"badge" "agent_badge" NOT NULL,
	"earned_at" timestamp DEFAULT now(),
	"notified" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "agent_anomalies" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"type" "anomaly_type" NOT NULL,
	"severity" "anomaly_severity" NOT NULL,
	"description" text NOT NULL,
	"evidence" jsonb,
	"resolved" boolean DEFAULT false,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_commissions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"transaction_id" text,
	"operation_type" text NOT NULL,
	"gross_amount" numeric(20, 4) NOT NULL,
	"commission_amount" numeric(20, 4) NOT NULL,
	"agent_share" numeric(20, 4) NOT NULL,
	"super_agent_share" numeric(20, 4) DEFAULT '0',
	"kowri_share" numeric(20, 4) NOT NULL,
	"status" text DEFAULT 'pending',
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_rankings" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"zone" text NOT NULL,
	"period" text NOT NULL,
	"volume_rank" integer,
	"trust_rank" integer,
	"overall_score" numeric(5, 2),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"cash_balance" numeric(20, 4) DEFAULT '0',
	"float_balance" numeric(20, 4) DEFAULT '0',
	"min_cash_threshold" numeric(20, 4),
	"min_float_threshold" numeric(20, 4),
	"max_cash_balance" numeric(20, 4),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"type" "agent_type" NOT NULL,
	"phone" text NOT NULL,
	"zone" text NOT NULL,
	"status" "agent_status" DEFAULT 'ACTIVE',
	"parent_agent_id" text,
	"monthly_volume" numeric(20, 4) DEFAULT '0',
	"commission_tier" integer DEFAULT 1,
	"trust_score" integer DEFAULT 100,
	"trust_level" "trust_level" DEFAULT 'TRUSTED',
	"anomaly_count" integer DEFAULT 0,
	"caution_deposit" numeric(20, 4) DEFAULT '0',
	"daily_cash_limit" numeric(20, 4),
	"daily_withdrawal_limit" numeric(20, 4),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "beneficiaries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"wallet_id" text,
	"relationship" text DEFAULT 'other' NOT NULL,
	"country" text NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"date" date NOT NULL,
	"system_expected_cash" numeric(20, 4),
	"agent_declared_cash" numeric(20, 4),
	"delta" numeric(20, 4),
	"status" "recon_status" DEFAULT 'PENDING',
	"agent_note" text,
	"photo_proof" text,
	"resolved_by" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "creator_communities" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"creator_id" text NOT NULL,
	"handle" text NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"wallet_id" text,
	"platform_fee_rate" numeric(5, 2) DEFAULT '2' NOT NULL,
	"creator_fee_rate" numeric(5, 2) DEFAULT '5' NOT NULL,
	"total_volume" numeric(20, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "creator_communities_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "insurance_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"pool_id" text NOT NULL,
	"user_id" text NOT NULL,
	"claim_amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"reason" text NOT NULL,
	"evidence_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"adjudicator_id" text,
	"payout_amount" numeric(20, 4),
	"rejection_reason" text,
	"transaction_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "insurance_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"start_date" timestamp DEFAULT now() NOT NULL,
	"end_date" timestamp,
	"premium_paid_at" timestamp,
	"next_premium_at" timestamp,
	"status" text DEFAULT 'active' NOT NULL,
	"claims_count" integer DEFAULT 0 NOT NULL,
	"total_premium_paid" numeric(20, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"insurance_type" text DEFAULT 'general' NOT NULL,
	"wallet_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"premium_amount" numeric(20, 4) NOT NULL,
	"premium_freq" text DEFAULT 'monthly' NOT NULL,
	"claim_limit" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"max_members" integer DEFAULT 100 NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"reserve_ratio" numeric(5, 2) DEFAULT '20' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"pool_type" text DEFAULT 'general' NOT NULL,
	"manager_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"goal_amount" numeric(20, 4) NOT NULL,
	"current_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"min_investment" numeric(20, 4) DEFAULT '1000' NOT NULL,
	"expected_return" numeric(5, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closing_date" timestamp,
	"maturity_date" timestamp,
	"total_shares" numeric(20, 4) DEFAULT '0' NOT NULL,
	"platform_fee_rate" numeric(5, 2) DEFAULT '2' NOT NULL,
	"creator_fee_rate" numeric(5, 2) DEFAULT '1' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liquidity_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"type" "alert_type" NOT NULL,
	"level" "alert_level" NOT NULL,
	"message" text NOT NULL,
	"suggested_action" text,
	"nearest_agent_id" text,
	"resolved" boolean DEFAULT false,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "liquidity_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"from_agent_id" text,
	"to_agent_id" text,
	"amount" numeric(20, 4) NOT NULL,
	"type" "liquidity_type" NOT NULL,
	"status" "liquidity_status" DEFAULT 'PENDING',
	"initiated_by" text,
	"note" text,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "loan_repayments" (
	"id" text PRIMARY KEY NOT NULL,
	"loan_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"transaction_id" text,
	"scheduled_at" timestamp,
	"paid_at" timestamp,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"pool_id" text NOT NULL,
	"user_id" text NOT NULL,
	"shares" numeric(20, 8) DEFAULT '0' NOT NULL,
	"invested_amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"return_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"redeemed_at" timestamp,
	"transaction_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_wallet_id" text NOT NULL,
	"beneficiary_id" text NOT NULL,
	"to_wallet_id" text,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"next_run_at" timestamp NOT NULL,
	"last_run_at" timestamp,
	"run_count" integer DEFAULT 0 NOT NULL,
	"max_runs" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remittance_corridors" (
	"id" text PRIMARY KEY NOT NULL,
	"from_country" text NOT NULL,
	"to_country" text NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"processor_id" text DEFAULT 'flutterwave' NOT NULL,
	"flat_fee" numeric(20, 4) DEFAULT '0' NOT NULL,
	"percent_fee" numeric(5, 2) DEFAULT '1' NOT NULL,
	"max_amount" numeric(20, 4) DEFAULT '5000000' NOT NULL,
	"min_amount" numeric(20, 4) DEFAULT '100' NOT NULL,
	"estimated_mins" integer DEFAULT 60 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reputation_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"contribution_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"repayment_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"reciprocity_score" integer DEFAULT 0 NOT NULL,
	"longevity_score" integer DEFAULT 0 NOT NULL,
	"regularity_score" integer DEFAULT 0 NOT NULL,
	"tontine_score" integer DEFAULT 0 NOT NULL,
	"tier" text DEFAULT 'new' NOT NULL,
	"badges" jsonb,
	"calculated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "reputation_scores_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "savings_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"name" text NOT NULL,
	"locked_amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"interest_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"term_days" integer NOT NULL,
	"start_date" timestamp DEFAULT now() NOT NULL,
	"maturity_date" timestamp NOT NULL,
	"accrued_yield" numeric(20, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"early_break_penalty" numeric(5, 2) DEFAULT '10' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"run_at" timestamp,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_number" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"category" "ticket_category" NOT NULL,
	"priority" "ticket_priority" DEFAULT 'LOW' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "ticket_status" DEFAULT 'OPEN' NOT NULL,
	"assigned_to" text,
	"linked_transaction_id" text,
	"resolution" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "support_tickets_ticket_number_unique" UNIQUE("ticket_number")
);
--> statement-breakpoint
CREATE TABLE "tontine_ai_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"tontine_id" text NOT NULL,
	"user_id" text NOT NULL,
	"priority_score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"factors" jsonb,
	"recommendation" text,
	"assessed_at" timestamp DEFAULT now() NOT NULL,
	"applied" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tontine_bids" (
	"id" text PRIMARY KEY NOT NULL,
	"tontine_id" text NOT NULL,
	"user_id" text NOT NULL,
	"listing_id" text,
	"bid_amount" numeric(20, 4) NOT NULL,
	"desired_position" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"round_number" integer DEFAULT 1 NOT NULL,
	"transaction_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "tontine_hybrid_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"tontine_id" text NOT NULL,
	"round" integer NOT NULL,
	"total_pool" numeric(20, 4) NOT NULL,
	"rotation_amount" numeric(20, 4) NOT NULL,
	"investment_amount" numeric(20, 4) NOT NULL,
	"solidarity_amount" numeric(20, 4) NOT NULL,
	"yield_amount" numeric(20, 4) NOT NULL,
	"recipient_user_id" text,
	"yield_recipients" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tontine_position_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"tontine_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"payout_order" integer NOT NULL,
	"ask_price" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'XOF' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"buyer_id" text,
	"transaction_id" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sold_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "tontine_purchase_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"tontine_id" text NOT NULL,
	"vendor_name" text NOT NULL,
	"vendor_wallet_id" text,
	"vendor_phone" text,
	"goal_amount" numeric(20, 4) NOT NULL,
	"goal_description" text NOT NULL,
	"current_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"status" "purchase_goal_status" DEFAULT 'open' NOT NULL,
	"release_condition" "release_condition" DEFAULT 'goal_reached' NOT NULL,
	"target_date" timestamp,
	"votes_required" integer,
	"votes_received" integer DEFAULT 0 NOT NULL,
	"released_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tontine_solidarity_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"tontine_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"reason" text NOT NULL,
	"urgency" "solidarity_claim_urgency" DEFAULT 'low' NOT NULL,
	"status" "solidarity_claim_status" DEFAULT 'pending_admin' NOT NULL,
	"auto_approved" boolean DEFAULT false NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp,
	"disbursed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tontine_strategy_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"tontine_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"allocated_amount" numeric(20, 4) NOT NULL,
	"purpose" text NOT NULL,
	"performance_score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"revenue_generated" numeric(20, 4) DEFAULT '0' NOT NULL,
	"status" "strategy_target_status" DEFAULT 'funded' NOT NULL,
	"funded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawal_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"approved_by" text,
	"approval_code" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fee_config" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_type" "fee_operation_type" NOT NULL,
	"min_amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"max_amount" numeric(20, 4),
	"fee_rate_bps" integer NOT NULL,
	"fee_min_abs" numeric(20, 4) DEFAULT '0' NOT NULL,
	"fee_max_abs" numeric(20, 4),
	"user_tier" "fee_user_tier" DEFAULT 'all' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"name" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_balance_summary" (
	"id" integer PRIMARY KEY NOT NULL,
	"total_credit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total_debit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_from_wallet_id_wallets_id_fk" FOREIGN KEY ("from_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_to_wallet_id_wallets_id_fk" FOREIGN KEY ("to_wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tontine_members" ADD CONSTRAINT "tontine_members_tontine_id_tontines_id_fk" FOREIGN KEY ("tontine_id") REFERENCES "public"."tontines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tontine_members" ADD CONSTRAINT "tontine_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tontines" ADD CONSTRAINT "tontines_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tontines" ADD CONSTRAINT "tontines_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_scores" ADD CONSTRAINT "credit_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clearing_entries" ADD CONSTRAINT "clearing_entries_batch_id_clearing_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."clearing_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_liquidity_positions" ADD CONSTRAINT "fx_liquidity_positions_pool_id_fx_liquidity_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."fx_liquidity_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_entries" ADD CONSTRAINT "report_entries_report_id_regulatory_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."regulatory_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallets_user_idx" ON "wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wallets_status_idx" ON "wallets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ledger_wallet_idx" ON "ledger_entries" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "ledger_account_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_created_idx" ON "ledger_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ledger_tx_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "txn_from_wallet_idx" ON "transactions" USING btree ("from_wallet_id");--> statement-breakpoint
CREATE INDEX "txn_to_wallet_idx" ON "transactions" USING btree ("to_wallet_id");--> statement-breakpoint
CREATE INDEX "txn_created_idx" ON "transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "txn_status_idx" ON "transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tontine_members_tontine_idx" ON "tontine_members" USING btree ("tontine_id");--> statement-breakpoint
CREATE INDEX "tontine_members_user_idx" ON "tontine_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tontine_members_payout_idx" ON "tontine_members" USING btree ("payout_order");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idem_key_idx" ON "idempotency_keys" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idem_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idem_key_endpoint_uidx" ON "idempotency_keys" USING btree ("key","endpoint");--> statement-breakpoint
CREATE INDEX "aml_flags_wallet_idx" ON "aml_flags" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "compliance_cases_wallet_idx" ON "compliance_cases" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "fx_history_pair_idx" ON "fx_rate_history" USING btree ("base_currency","target_currency","recorded_at");--> statement-breakpoint
CREATE INDEX "archive_wallet_year_idx" ON "ledger_archive" USING btree ("wallet_id","archive_year");--> statement-breakpoint
CREATE INDEX "archive_year_idx" ON "ledger_archive" USING btree ("archive_year");--> statement-breakpoint
CREATE INDEX "mq_topic_status_idx" ON "message_queue" USING btree ("topic","status");--> statement-breakpoint
CREATE INDEX "mq_created_idx" ON "message_queue" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "traces_trace_id_idx" ON "service_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "traces_service_idx" ON "service_traces" USING btree ("service");--> statement-breakpoint
CREATE INDEX "clearing_batches_status_idx" ON "clearing_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clearing_batches_institution_idx" ON "clearing_batches" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "clearing_entries_batch_idx" ON "clearing_entries" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "clearing_entries_status_idx" ON "clearing_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fraud_edges_from_idx" ON "fraud_network_edges" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "fraud_edges_to_idx" ON "fraud_network_edges" USING btree ("to_node_id");--> statement-breakpoint
CREATE INDEX "fraud_nodes_wallet_idx" ON "fraud_network_nodes" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "fraud_nodes_risk_idx" ON "fraud_network_nodes" USING btree ("risk_score");--> statement-breakpoint
CREATE INDEX "fraud_scores_wallet_idx" ON "fraud_scores" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "fraud_scores_score_idx" ON "fraud_scores" USING btree ("score");--> statement-breakpoint
CREATE INDEX "fx_positions_pool_idx" ON "fx_liquidity_positions" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "fx_positions_pair_idx" ON "fx_liquidity_positions" USING btree ("base_currency","target_currency");--> statement-breakpoint
CREATE INDEX "reg_reports_type_idx" ON "regulatory_reports" USING btree ("report_type");--> statement-breakpoint
CREATE INDEX "reg_reports_status_idx" ON "regulatory_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "report_entries_report_idx" ON "report_entries" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "devkeys_developer_idx" ON "developer_api_keys" USING btree ("developer_id");--> statement-breakpoint
CREATE INDEX "devkeys_prefix_idx" ON "developer_api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "usage_key_idx" ON "developer_usage_logs" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "usage_created_idx" ON "developer_usage_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "invoices_merchant_idx" ON "product_invoices" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "product_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifs_user_idx" ON "product_notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifs_read_idx" ON "product_notifications" USING btree ("read");--> statement-breakpoint
CREATE INDEX "paylinks_merchant_idx" ON "product_payment_links" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "paylinks_slug_idx" ON "product_payment_links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "qr_entity_idx" ON "product_qr_codes" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "qr_status_idx" ON "product_qr_codes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_token_idx" ON "product_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "product_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "achievement_agent_idx" ON "agent_achievements" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "achievement_badge_idx" ON "agent_achievements" USING btree ("badge");--> statement-breakpoint
CREATE INDEX "aganom_agent_idx" ON "agent_anomalies" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "aganom_type_idx" ON "agent_anomalies" USING btree ("type");--> statement-breakpoint
CREATE INDEX "aganom_severity_idx" ON "agent_anomalies" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "aganom_resolved_idx" ON "agent_anomalies" USING btree ("resolved");--> statement-breakpoint
CREATE INDEX "agcom_agent_idx" ON "agent_commissions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agcom_tx_idx" ON "agent_commissions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "agcom_status_idx" ON "agent_commissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agcom_optype_idx" ON "agent_commissions" USING btree ("operation_type");--> statement-breakpoint
CREATE INDEX "ranking_agent_idx" ON "agent_rankings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ranking_zone_idx" ON "agent_rankings" USING btree ("zone");--> statement-breakpoint
CREATE INDEX "ranking_period_idx" ON "agent_rankings" USING btree ("period");--> statement-breakpoint
CREATE INDEX "agwallet_agent_idx" ON "agent_wallets" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agwallet_wallet_idx" ON "agent_wallets" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "agent_user_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_zone_idx" ON "agents" USING btree ("zone");--> statement-breakpoint
CREATE INDEX "agent_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_type_idx" ON "agents" USING btree ("type");--> statement-breakpoint
CREATE INDEX "agent_trust_idx" ON "agents" USING btree ("trust_level");--> statement-breakpoint
CREATE INDEX "bene_user_idx" ON "beneficiaries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bene_country_idx" ON "beneficiaries" USING btree ("country");--> statement-breakpoint
CREATE INDEX "recon_agent_idx" ON "cash_reconciliations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "recon_date_idx" ON "cash_reconciliations" USING btree ("date");--> statement-breakpoint
CREATE INDEX "recon_status_idx" ON "cash_reconciliations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "creator_creator_idx" ON "creator_communities" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "creator_handle_idx" ON "creator_communities" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "creator_status_idx" ON "creator_communities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "insclaim_policy_idx" ON "insurance_claims" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "insclaim_pool_idx" ON "insurance_claims" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "insclaim_user_idx" ON "insurance_claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "insclaim_status_idx" ON "insurance_claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inspol_pool_idx" ON "insurance_policies" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "inspol_user_idx" ON "insurance_policies" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inspol_status_idx" ON "insurance_policies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inspool_manager_idx" ON "insurance_pools" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX "inspool_status_idx" ON "insurance_pools" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inspool_type_idx" ON "insurance_pools" USING btree ("insurance_type");--> statement-breakpoint
CREATE INDEX "pools_manager_idx" ON "investment_pools" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX "pools_status_idx" ON "investment_pools" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pools_type_idx" ON "investment_pools" USING btree ("pool_type");--> statement-breakpoint
CREATE INDEX "liqalert_agent_idx" ON "liquidity_alerts" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "liqalert_type_idx" ON "liquidity_alerts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "liqalert_level_idx" ON "liquidity_alerts" USING btree ("level");--> statement-breakpoint
CREATE INDEX "liqalert_resolved_idx" ON "liquidity_alerts" USING btree ("resolved");--> statement-breakpoint
CREATE INDEX "liqtx_from_idx" ON "liquidity_transfers" USING btree ("from_agent_id");--> statement-breakpoint
CREATE INDEX "liqtx_to_idx" ON "liquidity_transfers" USING btree ("to_agent_id");--> statement-breakpoint
CREATE INDEX "liqtx_status_idx" ON "liquidity_transfers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "repay_loan_idx" ON "loan_repayments" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "repay_user_idx" ON "loan_repayments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "repay_status_idx" ON "loan_repayments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "positions_pool_idx" ON "pool_positions" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "positions_user_idx" ON "pool_positions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "positions_status_idx" ON "pool_positions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recurring_user_idx" ON "recurring_transfers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recurring_status_idx" ON "recurring_transfers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recurring_nextrun_idx" ON "recurring_transfers" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "corridor_from_idx" ON "remittance_corridors" USING btree ("from_country");--> statement-breakpoint
CREATE INDEX "corridor_to_idx" ON "remittance_corridors" USING btree ("to_country");--> statement-breakpoint
CREATE INDEX "corridor_active_idx" ON "remittance_corridors" USING btree ("active");--> statement-breakpoint
CREATE INDEX "rep_user_idx" ON "reputation_scores" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rep_score_idx" ON "reputation_scores" USING btree ("score");--> statement-breakpoint
CREATE INDEX "rep_tier_idx" ON "reputation_scores" USING btree ("tier");--> statement-breakpoint
CREATE INDEX "savings_user_idx" ON "savings_plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "savings_wallet_idx" ON "savings_plans" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "savings_status_idx" ON "savings_plans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "savings_maturity_idx" ON "savings_plans" USING btree ("maturity_date");--> statement-breakpoint
CREATE INDEX "sched_type_idx" ON "scheduler_jobs" USING btree ("job_type");--> statement-breakpoint
CREATE INDEX "sched_entity_idx" ON "scheduler_jobs" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "sched_status_idx" ON "scheduler_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sched_scheduledat_idx" ON "scheduler_jobs" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "ticket_user_idx" ON "support_tickets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ticket_agent_idx" ON "support_tickets" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ticket_status_idx" ON "support_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ticket_priority_idx" ON "support_tickets" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "ticket_category_idx" ON "support_tickets" USING btree ("category");--> statement-breakpoint
CREATE INDEX "aiassess_tontine_idx" ON "tontine_ai_assessments" USING btree ("tontine_id");--> statement-breakpoint
CREATE INDEX "aiassess_user_idx" ON "tontine_ai_assessments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "aiassess_score_idx" ON "tontine_ai_assessments" USING btree ("priority_score");--> statement-breakpoint
CREATE INDEX "bids_tontine_idx" ON "tontine_bids" USING btree ("tontine_id");--> statement-breakpoint
CREATE INDEX "bids_user_idx" ON "tontine_bids" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bids_status_idx" ON "tontine_bids" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hybrid_cycle_tontine_idx" ON "tontine_hybrid_cycles" USING btree ("tontine_id");--> statement-breakpoint
CREATE INDEX "hybrid_cycle_round_idx" ON "tontine_hybrid_cycles" USING btree ("round");--> statement-breakpoint
CREATE INDEX "poslist_tontine_idx" ON "tontine_position_listings" USING btree ("tontine_id");--> statement-breakpoint
CREATE INDEX "poslist_seller_idx" ON "tontine_position_listings" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "poslist_status_idx" ON "tontine_position_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pgoal_tontine_idx" ON "tontine_purchase_goals" USING btree ("tontine_id");--> statement-breakpoint
CREATE INDEX "pgoal_status_idx" ON "tontine_purchase_goals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "solidclaim_tontine_idx" ON "tontine_solidarity_claims" USING btree ("tontine_id");--> statement-breakpoint
CREATE INDEX "solidclaim_user_idx" ON "tontine_solidarity_claims" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "solidclaim_status_idx" ON "tontine_solidarity_claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "strat_tontine_idx" ON "tontine_strategy_targets" USING btree ("tontine_id");--> statement-breakpoint
CREATE INDEX "strat_merchant_idx" ON "tontine_strategy_targets" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "strat_status_idx" ON "tontine_strategy_targets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wdapproval_agent_idx" ON "withdrawal_approvals" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "wdapproval_tx_idx" ON "withdrawal_approvals" USING btree ("transaction_id");