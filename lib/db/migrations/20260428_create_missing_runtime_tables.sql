-- Minimal runtime compatibility tables for api-server

-- Generated from lib/db schema for tables referenced in backend SQL/Drizzle usage



CREATE TABLE IF NOT EXISTS public.agent_achievements (
  id text PRIMARY KEY,
  agent_id text,
  badge text,
  earned_at timestamp DEFAULT now(),
  notified boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.agent_anomalies (
  id text PRIMARY KEY,
  agent_id text,
  type text,
  severity text,
  description text,
  evidence jsonb,
  resolved boolean DEFAULT false,
  resolved_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_commissions (
  id text PRIMARY KEY,
  agent_id text,
  transaction_id text,
  operation_type text,
  gross_amount numeric,
  commission_amount numeric,
  agent_share numeric,
  super_agent_share numeric DEFAULT '0',
  kowri_share numeric,
  status text DEFAULT 'pending',
  paid_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_rankings (
  id text PRIMARY KEY,
  agent_id text,
  zone text,
  period text,
  volume_rank integer,
  trust_rank integer,
  overall_score numeric,
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_wallets (
  id text PRIMARY KEY,
  agent_id text,
  wallet_id text,
  cash_balance numeric DEFAULT '0',
  float_balance numeric DEFAULT '0',
  min_cash_threshold numeric,
  min_float_threshold numeric,
  max_cash_balance numeric,
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agents (
  id text PRIMARY KEY,
  user_id text,
  name text,
  type text,
  phone text,
  zone text,
  status text DEFAULT 'ACTIVE',
  parent_agent_id text,
  monthly_volume numeric DEFAULT '0',
  commission_tier integer DEFAULT 1,
  trust_score integer DEFAULT 100,
  trust_level text DEFAULT 'TRUSTED',
  anomaly_count integer DEFAULT 0,
  caution_deposit numeric DEFAULT '0',
  daily_cash_limit numeric,
  daily_withdrawal_limit numeric,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.aml_flags (
  id text PRIMARY KEY,
  wallet_id text,
  transaction_id text,
  reason text,
  severity text DEFAULT 'medium',
  metadata jsonb,
  reviewed boolean DEFAULT false,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id text PRIMARY KEY,
  action text,
  entity text,
  entity_id text,
  actor text DEFAULT 'system',
  timestamp timestamp DEFAULT now(),
  metadata jsonb
);

CREATE TABLE IF NOT EXISTS public.beneficiaries (
  id text PRIMARY KEY,
  user_id text,
  name text,
  phone text,
  wallet_id text,
  relationship text DEFAULT 'other',
  country text,
  currency text DEFAULT 'XOF',
  active boolean DEFAULT true,
  metadata jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cash_reconciliations (
  id text PRIMARY KEY,
  agent_id text,
  date date,
  system_expected_cash numeric,
  agent_declared_cash numeric,
  delta numeric,
  status text DEFAULT 'PENDING',
  agent_note text,
  photo_proof text,
  resolved_by text,
  resolved_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.clearing_batches (
  id text PRIMARY KEY,
  batch_ref text,
  institution_id text,
  status text DEFAULT 'pending',
  total_amount numeric DEFAULT '0',
  currency text DEFAULT 'XOF',
  entry_count integer DEFAULT 0,
  metadata jsonb,
  submitted_at timestamp,
  settled_at timestamp,
  failed_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.clearing_entries (
  id text PRIMARY KEY,
  batch_id text,
  from_account_id text,
  to_account_id text,
  amount numeric,
  currency text DEFAULT 'XOF',
  status text DEFAULT 'pending',
  external_ref text,
  metadata jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.compliance_cases (
  id text PRIMARY KEY,
  wallet_id text,
  case_type text,
  status text DEFAULT 'open',
  severity text DEFAULT 'medium',
  details jsonb,
  created_at timestamp DEFAULT now(),
  resolved_at timestamp
);

CREATE TABLE IF NOT EXISTS public.connectors (
  id text PRIMARY KEY,
  name text,
  connector_type text,
  active boolean DEFAULT true,
  config jsonb DEFAULT '{}'::jsonb,
  last_ping_ms integer,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.creator_communities (
  id text PRIMARY KEY,
  name text,
  description text,
  creator_id text,
  handle text,
  member_count integer DEFAULT 0,
  wallet_id text,
  platform_fee_rate numeric DEFAULT '2',
  creator_fee_rate numeric DEFAULT '5',
  total_volume numeric DEFAULT '0',
  status text DEFAULT 'active',
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.credit_scores (
  id text PRIMARY KEY,
  user_id text,
  score integer DEFAULT 300,
  tier text DEFAULT 'bronze',
  max_loan_amount numeric DEFAULT '0',
  interest_rate numeric DEFAULT '15',
  payment_history integer DEFAULT 0,
  savings_regularity integer DEFAULT 0,
  transaction_volume integer DEFAULT 0,
  tontine_participation integer DEFAULT 0,
  network_score integer DEFAULT 0,
  last_updated timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.developer_api_keys (
  id text PRIMARY KEY,
  developer_id text,
  name text,
  key_prefix text,
  key_hash text,
  scopes jsonb DEFAULT '[]'::jsonb,
  plan_tier text DEFAULT 'free',
  active boolean DEFAULT true,
  daily_limit integer DEFAULT 1000,
  monthly_limit integer DEFAULT 10000,
  request_count integer DEFAULT 0,
  last_used_at timestamp,
  environment text DEFAULT 'sandbox',
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.developer_usage_logs (
  id text PRIMARY KEY,
  api_key_id text,
  endpoint text,
  method text DEFAULT 'GET',
  status_code integer DEFAULT 200,
  response_ms integer DEFAULT 0,
  ip_address text,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_log (
  id text PRIMARY KEY,
  event_type text,
  payload jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id text PRIMARY KEY,
  base_currency text,
  target_currency text,
  rate numeric,
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fee_config (
  id text PRIMARY KEY,
  operation_type text,
  min_amount numeric DEFAULT '0',
  max_amount numeric,
  fee_rate_bps integer,
  fee_min_abs numeric DEFAULT '0',
  fee_max_abs numeric,
  user_tier text DEFAULT 'all',
  active boolean DEFAULT true,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fraud_network_edges (
  id text PRIMARY KEY,
  from_node_id text,
  to_node_id text,
  edge_type text DEFAULT 'transfer',
  weight numeric DEFAULT '1',
  transaction_count integer DEFAULT 1,
  total_amount numeric DEFAULT '0',
  currency text DEFAULT 'XOF',
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fraud_network_nodes (
  id text PRIMARY KEY,
  wallet_id text,
  node_type text DEFAULT 'wallet',
  risk_score numeric DEFAULT '0',
  transaction_count integer DEFAULT 0,
  flagged_count integer DEFAULT 0,
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fraud_scores (
  id text PRIMARY KEY,
  wallet_id text,
  score numeric DEFAULT '0',
  factors jsonb,
  model_version text DEFAULT 'v1',
  calculated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fx_liquidity_pools (
  id text PRIMARY KEY,
  currency text,
  pool_size numeric DEFAULT '0',
  available numeric DEFAULT '0',
  reserved numeric DEFAULT '0',
  utilization_pct numeric DEFAULT '0',
  min_threshold numeric DEFAULT '0',
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fx_liquidity_positions (
  id text PRIMARY KEY,
  pool_id text,
  base_currency text,
  target_currency text,
  amount numeric,
  slippage_bps numeric DEFAULT '0',
  exposure numeric DEFAULT '0',
  status text DEFAULT 'open',
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fx_rate_history (
  id text PRIMARY KEY,
  base_currency text,
  target_currency text,
  rate numeric,
  source text DEFAULT 'internal',
  recorded_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id text PRIMARY KEY,
  key text,
  endpoint text,
  response_body jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.incidents (
  id text PRIMARY KEY,
  type text,
  action text,
  result text,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.insurance_claims (
  id text PRIMARY KEY,
  policy_id text,
  pool_id text,
  user_id text,
  claim_amount numeric,
  currency text DEFAULT 'XOF',
  reason text,
  evidence_url text,
  status text DEFAULT 'pending',
  adjudicator_id text,
  payout_amount numeric,
  rejection_reason text,
  transaction_id text,
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  resolved_at timestamp
);

CREATE TABLE IF NOT EXISTS public.insurance_policies (
  id text PRIMARY KEY,
  pool_id text,
  user_id text,
  wallet_id text,
  start_date timestamp DEFAULT now(),
  end_date timestamp,
  premium_paid_at timestamp,
  next_premium_at timestamp,
  status text DEFAULT 'active',
  claims_count integer DEFAULT 0,
  total_premium_paid numeric DEFAULT '0',
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.insurance_pools (
  id text PRIMARY KEY,
  name text,
  description text,
  insurance_type text DEFAULT 'general',
  wallet_id text,
  manager_id text,
  premium_amount numeric,
  premium_freq text DEFAULT 'monthly',
  claim_limit numeric,
  currency text DEFAULT 'XOF',
  max_members integer DEFAULT 100,
  member_count integer DEFAULT 0,
  reserve_ratio numeric DEFAULT '20',
  status text DEFAULT 'active',
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.investment_pools (
  id text PRIMARY KEY,
  name text,
  description text,
  pool_type text DEFAULT 'general',
  manager_id text,
  wallet_id text,
  goal_amount numeric,
  current_amount numeric DEFAULT '0',
  currency text DEFAULT 'XOF',
  min_investment numeric DEFAULT '1000',
  expected_return numeric DEFAULT '0',
  status text DEFAULT 'open',
  closing_date timestamp,
  maturity_date timestamp,
  total_shares numeric DEFAULT '0',
  platform_fee_rate numeric DEFAULT '2',
  creator_fee_rate numeric DEFAULT '1',
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kill_switches (
  name text PRIMARY KEY,
  enabled boolean DEFAULT true,
  reason text DEFAULT '',
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kyc_records (
  id text PRIMARY KEY,
  user_id text,
  document_type text,
  status text DEFAULT 'pending',
  kyc_level integer DEFAULT 1,
  document_number text,
  full_name text,
  date_of_birth text,
  document_front text,
  selfie text,
  proof_of_address text,
  second_document text,
  rejection_reason text,
  verified_at timestamp,
  submitted_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ledger_archive (
  id text PRIMARY KEY,
  original_tx_id text,
  wallet_id text,
  type text,
  amount numeric,
  currency text,
  balance_after numeric,
  archive_year integer,
  archived_at timestamp DEFAULT now(),
  original_created_at timestamp
);

CREATE TABLE IF NOT EXISTS public.ledger_balance_summary (
  id integer PRIMARY KEY,
  total_credit numeric DEFAULT '0',
  total_debit numeric DEFAULT '0',
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id text PRIMARY KEY,
  transaction_id text,
  account_id text,
  account_type text,
  debit_amount numeric DEFAULT '0',
  credit_amount numeric DEFAULT '0',
  currency text,
  event_type text,
  description text,
  entry_type text,
  wallet_id text,
  reference text,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ledger_shards (
  id text PRIMARY KEY,
  shard_key text,
  shard_index integer,
  wallet_id_range_start text,
  wallet_id_range_end text,
  entry_count integer DEFAULT 0,
  active boolean DEFAULT true,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.liquidity_alerts (
  id text PRIMARY KEY,
  agent_id text,
  type text,
  level text,
  message text,
  suggested_action text,
  nearest_agent_id text,
  resolved boolean DEFAULT false,
  resolved_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.liquidity_transfers (
  id text PRIMARY KEY,
  from_agent_id text,
  to_agent_id text,
  amount numeric,
  type text,
  status text DEFAULT 'PENDING',
  initiated_by text,
  note text,
  created_at timestamp DEFAULT now(),
  completed_at timestamp
);

CREATE TABLE IF NOT EXISTS public.loan_repayments (
  id text PRIMARY KEY,
  loan_id text,
  user_id text,
  amount numeric,
  currency text DEFAULT 'XOF',
  transaction_id text,
  scheduled_at timestamp,
  paid_at timestamp,
  status text DEFAULT 'pending',
  metadata jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.loans (
  id text PRIMARY KEY,
  user_id text,
  wallet_id text,
  amount numeric,
  currency text DEFAULT 'XOF',
  interest_rate numeric,
  term_days integer,
  status text DEFAULT 'pending',
  amount_repaid numeric DEFAULT '0',
  purpose text,
  due_date timestamp,
  disbursed_at timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.merchants (
  id text PRIMARY KEY,
  user_id text,
  business_name text,
  business_type text,
  status text DEFAULT 'pending_approval',
  wallet_id text,
  api_key text,
  country text,
  total_revenue numeric DEFAULT '0',
  transaction_count integer DEFAULT 0,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.message_queue (
  id text PRIMARY KEY,
  topic text,
  payload jsonb,
  status text DEFAULT 'pending',
  consumer_group text,
  attempts integer DEFAULT 0,
  processed_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.metrics (
  id text PRIMARY KEY,
  key text,
  value numeric,
  timestamp timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payment_routes (
  id text PRIMARY KEY,
  route_type text,
  processor text,
  priority integer DEFAULT 100,
  active boolean DEFAULT true,
  config jsonb DEFAULT '{}'::jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pool_positions (
  id text PRIMARY KEY,
  pool_id text,
  user_id text,
  shares numeric DEFAULT '0',
  invested_amount numeric,
  currency text DEFAULT 'XOF',
  status text DEFAULT 'active',
  return_amount numeric DEFAULT '0',
  redeemed_at timestamp,
  transaction_id text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_invoices (
  id text PRIMARY KEY,
  merchant_id text,
  invoice_number text,
  customer_name text,
  customer_email text,
  customer_phone text,
  items jsonb DEFAULT '[]'::jsonb,
  subtotal numeric DEFAULT '0',
  tax numeric DEFAULT '0',
  total numeric DEFAULT '0',
  currency text DEFAULT 'XOF',
  status text DEFAULT 'draft',
  notes text,
  due_at timestamp,
  paid_at timestamp,
  transaction_id text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_notifications (
  id text PRIMARY KEY,
  user_id text,
  type text,
  title text,
  message text,
  channel text DEFAULT 'in_app',
  read boolean DEFAULT false,
  metadata jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_payment_links (
  id text PRIMARY KEY,
  merchant_id text,
  slug text,
  title text,
  description text,
  amount numeric,
  currency text DEFAULT 'XOF',
  status text DEFAULT 'active',
  click_count integer DEFAULT 0,
  paid_count integer DEFAULT 0,
  metadata jsonb,
  expires_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_qr_codes (
  id text PRIMARY KEY,
  entity_id text,
  entity_type text DEFAULT 'wallet',
  amount numeric,
  currency text DEFAULT 'XOF',
  label text,
  qr_data text,
  status text DEFAULT 'active',
  use_count integer DEFAULT 0,
  max_uses integer,
  expires_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_sessions (
  id text PRIMARY KEY,
  user_id text,
  token text,
  type text DEFAULT 'wallet',
  device_id text,
  ip_address text,
  expires_at timestamp,
  created_at timestamp DEFAULT now(),
  last_used_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.recurring_transfers (
  id text PRIMARY KEY,
  user_id text,
  from_wallet_id text,
  beneficiary_id text,
  to_wallet_id text,
  amount numeric,
  currency text DEFAULT 'XOF',
  frequency text DEFAULT 'monthly',
  next_run_at timestamp,
  last_run_at timestamp,
  run_count integer DEFAULT 0,
  max_runs integer,
  status text DEFAULT 'active',
  description text,
  metadata jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.regulatory_reports (
  id text PRIMARY KEY,
  report_type text,
  status text DEFAULT 'pending',
  format text DEFAULT 'json',
  period_start timestamp,
  period_end timestamp,
  record_count integer DEFAULT 0,
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  generated_at timestamp
);

CREATE TABLE IF NOT EXISTS public.remittance_corridors (
  id text PRIMARY KEY,
  from_country text,
  to_country text,
  from_currency text,
  to_currency text,
  processor_id text DEFAULT 'flutterwave',
  flat_fee numeric DEFAULT '0',
  percent_fee numeric DEFAULT '1',
  max_amount numeric DEFAULT '5000000',
  min_amount numeric DEFAULT '100',
  estimated_mins integer DEFAULT 60,
  active boolean DEFAULT true,
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.report_entries (
  id text PRIMARY KEY,
  report_id text,
  entry_type text,
  data jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reputation_scores (
  id text PRIMARY KEY,
  user_id text,
  score integer DEFAULT 0,
  contribution_rate numeric DEFAULT '0',
  repayment_rate numeric DEFAULT '0',
  reciprocity_score integer DEFAULT 0,
  longevity_score integer DEFAULT 0,
  regularity_score integer DEFAULT 0,
  tontine_score integer DEFAULT 0,
  tier text DEFAULT 'new',
  badges jsonb,
  calculated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.risk_alerts (
  id text PRIMARY KEY,
  wallet_id text,
  alert_type text,
  severity text DEFAULT 'medium',
  metadata jsonb,
  resolved boolean DEFAULT false,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sagas (
  id text PRIMARY KEY,
  saga_type text,
  status text DEFAULT 'started',
  steps jsonb DEFAULT '[]'::jsonb,
  context jsonb DEFAULT '{}'::jsonb,
  current_step integer DEFAULT 0,
  error text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.savings_plans (
  id text PRIMARY KEY,
  user_id text,
  wallet_id text,
  name text,
  locked_amount numeric,
  currency text DEFAULT 'XOF',
  interest_rate numeric DEFAULT '0',
  term_days integer,
  start_date timestamp DEFAULT now(),
  maturity_date timestamp,
  accrued_yield numeric DEFAULT '0',
  status text DEFAULT 'active',
  early_break_penalty numeric DEFAULT '10',
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.scheduler_jobs (
  id text PRIMARY KEY,
  job_type text,
  entity_id text,
  entity_type text,
  scheduled_at timestamp,
  run_at timestamp,
  status text DEFAULT 'pending',
  attempts integer DEFAULT 0,
  max_attempts integer DEFAULT 3,
  error text,
  metadata jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.service_traces (
  id text PRIMARY KEY,
  trace_id text,
  span_id text,
  parent_span_id text,
  service text,
  operation text,
  duration_ms integer,
  status text DEFAULT 'ok',
  metadata jsonb,
  started_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.settlements (
  id text PRIMARY KEY,
  partner text,
  amount numeric,
  currency text,
  status text DEFAULT 'pending',
  metadata jsonb,
  created_at timestamp DEFAULT now(),
  settled_at timestamp
);

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id text PRIMARY KEY,
  ticket_number text,
  user_id text,
  agent_id text,
  category text,
  priority text DEFAULT 'LOW',
  title text,
  description text,
  status text DEFAULT 'OPEN',
  assigned_to text,
  linked_transaction_id text,
  resolution text,
  resolved_at timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.system_state (
  key text PRIMARY KEY,
  value jsonb,
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tontine_ai_assessments (
  id text PRIMARY KEY,
  tontine_id text,
  user_id text,
  priority_score numeric DEFAULT '0',
  factors jsonb,
  recommendation text,
  assessed_at timestamp DEFAULT now(),
  applied boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.tontine_bids (
  id text PRIMARY KEY,
  tontine_id text,
  user_id text,
  bid_amount numeric,
  desired_position integer DEFAULT 1,
  status text DEFAULT 'pending',
  round_number integer DEFAULT 1,
  created_at timestamp DEFAULT now(),
  resolved_at timestamp
);

CREATE TABLE IF NOT EXISTS public.tontine_hybrid_cycles (
  id text PRIMARY KEY,
  tontine_id text,
  round integer,
  total_pool numeric,
  rotation_amount numeric,
  investment_amount numeric,
  solidarity_amount numeric,
  yield_amount numeric,
  recipient_user_id text,
  yield_recipients integer DEFAULT 0,
  metadata jsonb,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tontine_members (
  id text PRIMARY KEY,
  tontine_id text,
  user_id text,
  payout_order integer,
  has_received_payout integer DEFAULT 0,
  contributions_count integer DEFAULT 0,
  personal_contribution numeric,
  yield_owed numeric DEFAULT '0',
  yield_paid numeric DEFAULT '0',
  received_payout_at timestamp,
  joined_at timestamp DEFAULT now(),
  missed_contributions integer DEFAULT 0,
  member_status text DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS public.tontine_position_listings (
  id text PRIMARY KEY,
  tontine_id text,
  seller_id text,
  payout_order integer,
  ask_price numeric,
  currency text DEFAULT 'XOF',
  status text DEFAULT 'open',
  buyer_id text,
  transaction_id text,
  expires_at timestamp,
  created_at timestamp DEFAULT now(),
  sold_at timestamp
);

CREATE TABLE IF NOT EXISTS public.tontine_purchase_goals (
  id text PRIMARY KEY,
  tontine_id text,
  vendor_name text,
  vendor_wallet_id text,
  vendor_phone text,
  goal_amount numeric,
  goal_description text,
  current_amount numeric DEFAULT '0',
  status text DEFAULT 'open',
  release_condition text DEFAULT 'goal_reached',
  target_date timestamp,
  votes_required integer,
  votes_received integer DEFAULT 0,
  released_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tontine_solidarity_claims (
  id text PRIMARY KEY,
  tontine_id text,
  user_id text,
  amount numeric,
  reason text,
  urgency text DEFAULT 'low',
  status text DEFAULT 'pending_admin',
  auto_approved boolean DEFAULT false,
  reviewed_by text,
  reviewed_at timestamp,
  disbursed_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tontine_strategy_targets (
  id text PRIMARY KEY,
  tontine_id text,
  merchant_id text,
  allocated_amount numeric,
  purpose text,
  performance_score numeric DEFAULT '0',
  revenue_generated numeric DEFAULT '0',
  status text DEFAULT 'funded',
  funded_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tontines (
  id text PRIMARY KEY,
  name text,
  description text,
  contribution_amount numeric,
  currency text DEFAULT 'XOF',
  frequency text,
  max_members integer,
  member_count integer DEFAULT 0,
  current_round integer DEFAULT 0,
  total_rounds integer,
  status text DEFAULT 'pending',
  tontine_type text DEFAULT 'classic',
  is_public boolean DEFAULT true,
  is_multi_amount boolean DEFAULT false,
  goal_description text,
  goal_amount numeric,
  merchant_id text,
  investment_pool_id text,
  currency_mode text DEFAULT 'single',
  yield_rate numeric,
  yield_pool_balance numeric DEFAULT '0',
  growth_rate numeric,
  hybrid_config jsonb,
  solidarity_reserve numeric DEFAULT '0',
  strategy_mode boolean DEFAULT false,
  strategy_zone text,
  strategy_objective text,
  network_wallets jsonb,
  admin_user_id text,
  wallet_id text,
  next_payout_date timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transactions (
  id text PRIMARY KEY,
  from_wallet_id text,
  to_wallet_id text,
  amount numeric,
  currency text DEFAULT 'XOF',
  type text,
  status text DEFAULT 'pending',
  reference text,
  description text,
  metadata jsonb,
  idempotency_key text,
  created_at timestamp DEFAULT now(),
  completed_at timestamp
);

CREATE TABLE IF NOT EXISTS public.users (
  id text PRIMARY KEY,
  phone text,
  email text,
  first_name text,
  last_name text,
  status text DEFAULT 'pending_kyc',
  kyc_level integer DEFAULT 0,
  country text,
  pin_hash text,
  credit_score integer,
  is_active boolean DEFAULT true,
  avatar_url text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wallet_limits (
  wallet_id text PRIMARY KEY,
  max_tx_per_minute integer DEFAULT 10,
  max_hourly_volume numeric DEFAULT '5000000',
  max_daily_volume numeric DEFAULT '20000000',
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wallets (
  id text PRIMARY KEY,
  user_id text,
  currency text DEFAULT 'XOF',
  balance numeric DEFAULT '0',
  available_balance numeric DEFAULT '0',
  status text DEFAULT 'active',
  wallet_type text DEFAULT 'personal',
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.webhooks (
  id text PRIMARY KEY,
  url text,
  event_type text,
  secret text,
  active boolean DEFAULT true,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.withdrawal_approvals (
  id text PRIMARY KEY,
  transaction_id text,
  agent_id text,
  approved_by text,
  approval_code text,
  expires_at timestamp,
  used_at timestamp,
  created_at timestamp DEFAULT now()
);

