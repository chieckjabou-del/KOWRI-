import { pgTable, text, boolean, integer, numeric, timestamp, jsonb, index, pgEnum } from "drizzle-orm/pg-core";

export const savingsPlansTable = pgTable("savings_plans", {
  id:                text("id").primaryKey(),
  userId:            text("user_id").notNull(),
  walletId:          text("wallet_id").notNull(),
  name:              text("name").notNull(),
  lockedAmount:      numeric("locked_amount", { precision: 20, scale: 4 }).notNull(),
  currency:          text("currency").notNull().default("XOF"),
  interestRate:      numeric("interest_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  termDays:          integer("term_days").notNull(),
  startDate:         timestamp("start_date").notNull().defaultNow(),
  maturityDate:      timestamp("maturity_date").notNull(),
  accruedYield:      numeric("accrued_yield", { precision: 20, scale: 4 }).notNull().default("0"),
  status:            text("status").notNull().default("active"),
  earlyBreakPenalty: numeric("early_break_penalty", { precision: 5, scale: 2 }).notNull().default("10"),
  metadata:          jsonb("metadata"),
  createdAt:         timestamp("created_at").notNull().defaultNow(),
  updatedAt:         timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("savings_user_idx").on(t.userId),
  index("savings_wallet_idx").on(t.walletId),
  index("savings_status_idx").on(t.status),
  index("savings_maturity_idx").on(t.maturityDate),
]);

export const investmentPoolsTable = pgTable("investment_pools", {
  id:              text("id").primaryKey(),
  name:            text("name").notNull(),
  description:     text("description"),
  poolType:        text("pool_type").notNull().default("general"),
  managerId:       text("manager_id").notNull(),
  walletId:        text("wallet_id").notNull(),
  goalAmount:      numeric("goal_amount", { precision: 20, scale: 4 }).notNull(),
  currentAmount:   numeric("current_amount", { precision: 20, scale: 4 }).notNull().default("0"),
  currency:        text("currency").notNull().default("XOF"),
  minInvestment:   numeric("min_investment", { precision: 20, scale: 4 }).notNull().default("1000"),
  expectedReturn:  numeric("expected_return", { precision: 5, scale: 2 }).notNull().default("0"),
  status:          text("status").notNull().default("open"),
  closingDate:     timestamp("closing_date"),
  maturityDate:    timestamp("maturity_date"),
  totalShares:     numeric("total_shares", { precision: 20, scale: 4 }).notNull().default("0"),
  platformFeeRate: numeric("platform_fee_rate", { precision: 5, scale: 2 }).notNull().default("2"),
  creatorFeeRate:  numeric("creator_fee_rate", { precision: 5, scale: 2 }).notNull().default("1"),
  metadata:        jsonb("metadata"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("pools_manager_idx").on(t.managerId),
  index("pools_status_idx").on(t.status),
  index("pools_type_idx").on(t.poolType),
]);

export const poolPositionsTable = pgTable("pool_positions", {
  id:             text("id").primaryKey(),
  poolId:         text("pool_id").notNull(),
  userId:         text("user_id").notNull(),
  shares:         numeric("shares", { precision: 20, scale: 8 }).notNull().default("0"),
  investedAmount: numeric("invested_amount", { precision: 20, scale: 4 }).notNull(),
  currency:       text("currency").notNull().default("XOF"),
  status:         text("status").notNull().default("active"),
  returnAmount:   numeric("return_amount", { precision: 20, scale: 4 }).notNull().default("0"),
  redeemedAt:     timestamp("redeemed_at"),
  transactionId:  text("transaction_id"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("positions_pool_idx").on(t.poolId),
  index("positions_user_idx").on(t.userId),
  index("positions_status_idx").on(t.status),
]);

export const insurancePoolsTable = pgTable("insurance_pools", {
  id:              text("id").primaryKey(),
  name:            text("name").notNull(),
  description:     text("description"),
  insuranceType:   text("insurance_type").notNull().default("general"),
  walletId:        text("wallet_id").notNull(),
  managerId:       text("manager_id").notNull(),
  premiumAmount:   numeric("premium_amount", { precision: 20, scale: 4 }).notNull(),
  premiumFreq:     text("premium_freq").notNull().default("monthly"),
  claimLimit:      numeric("claim_limit", { precision: 20, scale: 4 }).notNull(),
  currency:        text("currency").notNull().default("XOF"),
  maxMembers:      integer("max_members").notNull().default(100),
  memberCount:     integer("member_count").notNull().default(0),
  reserveRatio:    numeric("reserve_ratio", { precision: 5, scale: 2 }).notNull().default("20"),
  status:          text("status").notNull().default("active"),
  metadata:        jsonb("metadata"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("inspool_manager_idx").on(t.managerId),
  index("inspool_status_idx").on(t.status),
  index("inspool_type_idx").on(t.insuranceType),
]);

export const insurancePoliciesTable = pgTable("insurance_policies", {
  id:             text("id").primaryKey(),
  poolId:         text("pool_id").notNull(),
  userId:         text("user_id").notNull(),
  walletId:       text("wallet_id").notNull(),
  startDate:      timestamp("start_date").notNull().defaultNow(),
  endDate:        timestamp("end_date"),
  premiumPaidAt:  timestamp("premium_paid_at"),
  nextPremiumAt:  timestamp("next_premium_at"),
  status:         text("status").notNull().default("active"),
  claimsCount:    integer("claims_count").notNull().default(0),
  totalPremiumPaid: numeric("total_premium_paid", { precision: 20, scale: 4 }).notNull().default("0"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("inspol_pool_idx").on(t.poolId),
  index("inspol_user_idx").on(t.userId),
  index("inspol_status_idx").on(t.status),
]);

export const insuranceClaimsTable = pgTable("insurance_claims", {
  id:             text("id").primaryKey(),
  policyId:       text("policy_id").notNull(),
  poolId:         text("pool_id").notNull(),
  userId:         text("user_id").notNull(),
  claimAmount:    numeric("claim_amount", { precision: 20, scale: 4 }).notNull(),
  currency:       text("currency").notNull().default("XOF"),
  reason:         text("reason").notNull(),
  evidenceUrl:    text("evidence_url"),
  status:         text("status").notNull().default("pending"),
  adjudicatorId:  text("adjudicator_id"),
  payoutAmount:   numeric("payout_amount", { precision: 20, scale: 4 }),
  rejectionReason: text("rejection_reason"),
  transactionId:  text("transaction_id"),
  metadata:       jsonb("metadata"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  resolvedAt:     timestamp("resolved_at"),
}, (t) => [
  index("insclaim_policy_idx").on(t.policyId),
  index("insclaim_pool_idx").on(t.poolId),
  index("insclaim_user_idx").on(t.userId),
  index("insclaim_status_idx").on(t.status),
]);

export const remittanceCorridorsTable = pgTable("remittance_corridors", {
  id:             text("id").primaryKey(),
  fromCountry:    text("from_country").notNull(),
  toCountry:      text("to_country").notNull(),
  fromCurrency:   text("from_currency").notNull(),
  toCurrency:     text("to_currency").notNull(),
  processorId:    text("processor_id").notNull().default("flutterwave"),
  flatFee:        numeric("flat_fee", { precision: 20, scale: 4 }).notNull().default("0"),
  percentFee:     numeric("percent_fee", { precision: 5, scale: 2 }).notNull().default("1"),
  maxAmount:      numeric("max_amount", { precision: 20, scale: 4 }).notNull().default("5000000"),
  minAmount:      numeric("min_amount", { precision: 20, scale: 4 }).notNull().default("100"),
  estimatedMins:  integer("estimated_mins").notNull().default(60),
  active:         boolean("active").notNull().default(true),
  metadata:       jsonb("metadata"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("corridor_from_idx").on(t.fromCountry),
  index("corridor_to_idx").on(t.toCountry),
  index("corridor_active_idx").on(t.active),
]);

export const beneficiariesTable = pgTable("beneficiaries", {
  id:           text("id").primaryKey(),
  userId:       text("user_id").notNull(),
  name:         text("name").notNull(),
  phone:        text("phone"),
  walletId:     text("wallet_id"),
  relationship: text("relationship").notNull().default("other"),
  country:      text("country").notNull(),
  currency:     text("currency").notNull().default("XOF"),
  active:       boolean("active").notNull().default(true),
  metadata:     jsonb("metadata"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("bene_user_idx").on(t.userId),
  index("bene_country_idx").on(t.country),
]);

export const recurringTransfersTable = pgTable("recurring_transfers", {
  id:              text("id").primaryKey(),
  userId:          text("user_id").notNull(),
  fromWalletId:    text("from_wallet_id").notNull(),
  beneficiaryId:   text("beneficiary_id").notNull(),
  toWalletId:      text("to_wallet_id"),
  amount:          numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency:        text("currency").notNull().default("XOF"),
  frequency:       text("frequency").notNull().default("monthly"),
  nextRunAt:       timestamp("next_run_at").notNull(),
  lastRunAt:       timestamp("last_run_at"),
  runCount:        integer("run_count").notNull().default(0),
  maxRuns:         integer("max_runs"),
  status:          text("status").notNull().default("active"),
  description:     text("description"),
  metadata:        jsonb("metadata"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("recurring_user_idx").on(t.userId),
  index("recurring_status_idx").on(t.status),
  index("recurring_nextrun_idx").on(t.nextRunAt),
]);

export const tontinePositionListingsTable = pgTable("tontine_position_listings", {
  id:           text("id").primaryKey(),
  tontineId:    text("tontine_id").notNull(),
  sellerId:     text("seller_id").notNull(),
  payoutOrder:  integer("payout_order").notNull(),
  askPrice:     numeric("ask_price", { precision: 20, scale: 4 }).notNull(),
  currency:     text("currency").notNull().default("XOF"),
  status:       text("status").notNull().default("open"),
  buyerId:      text("buyer_id"),
  transactionId: text("transaction_id"),
  expiresAt:    timestamp("expires_at"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
  soldAt:       timestamp("sold_at"),
}, (t) => [
  index("poslist_tontine_idx").on(t.tontineId),
  index("poslist_seller_idx").on(t.sellerId),
  index("poslist_status_idx").on(t.status),
]);

export const tontineBidsTable = pgTable("tontine_bids", {
  id:              text("id").primaryKey(),
  tontineId:       text("tontine_id").notNull(),
  userId:          text("user_id").notNull(),
  bidAmount:       numeric("bid_amount", { precision: 20, scale: 4 }).notNull(),
  desiredPosition: integer("desired_position").notNull().default(1),
  status:          text("status").notNull().default("pending"),
  roundNumber:     integer("round_number").notNull().default(1),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  resolvedAt:      timestamp("resolved_at"),
}, (t) => [
  index("bids_tontine_idx").on(t.tontineId),
  index("bids_user_idx").on(t.userId),
  index("bids_status_idx").on(t.status),
]);

export const reputationScoresTable = pgTable("reputation_scores", {
  id:                  text("id").primaryKey(),
  userId:              text("user_id").notNull().unique(),
  score:               integer("score").notNull().default(0),
  contributionRate:    numeric("contribution_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  repaymentRate:       numeric("repayment_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  reciprocityScore:    integer("reciprocity_score").notNull().default(0),
  longevityScore:      integer("longevity_score").notNull().default(0),
  regularityScore:     integer("regularity_score").notNull().default(0),
  tontineScore:        integer("tontine_score").notNull().default(0),
  tier:                text("tier").notNull().default("new"),
  badges:              jsonb("badges").$type<Array<{ badge: string; earnedAt: string; criteria: string }>>(),
  calculatedAt:        timestamp("calculated_at").notNull().defaultNow(),
}, (t) => [
  index("rep_user_idx").on(t.userId),
  index("rep_score_idx").on(t.score),
  index("rep_tier_idx").on(t.tier),
]);

export const tontineAiAssessmentsTable = pgTable("tontine_ai_assessments", {
  id:             text("id").primaryKey(),
  tontineId:      text("tontine_id").notNull(),
  userId:         text("user_id").notNull(),
  priorityScore:  numeric("priority_score", { precision: 5, scale: 2 }).notNull().default("0"),
  factors:        jsonb("factors").$type<{
    creditScore: number; reputationScore: number;
    needScore: number;   projectScore: number;
    creditFactor: number; reputationFactor: number;
  }>(),
  recommendation: text("recommendation"),
  assessedAt:     timestamp("assessed_at").notNull().defaultNow(),
  applied:        boolean("applied").notNull().default(false),
}, (t) => [
  index("aiassess_tontine_idx").on(t.tontineId),
  index("aiassess_user_idx").on(t.userId),
  index("aiassess_score_idx").on(t.priorityScore),
]);

export const creatorCommunitiesTable = pgTable("creator_communities", {
  id:              text("id").primaryKey(),
  name:            text("name").notNull(),
  description:     text("description"),
  creatorId:       text("creator_id").notNull(),
  handle:          text("handle").notNull().unique(),
  memberCount:     integer("member_count").notNull().default(0),
  walletId:        text("wallet_id"),
  platformFeeRate: numeric("platform_fee_rate", { precision: 5, scale: 2 }).notNull().default("2"),
  creatorFeeRate:  numeric("creator_fee_rate", { precision: 5, scale: 2 }).notNull().default("5"),
  totalVolume:     numeric("total_volume", { precision: 20, scale: 4 }).notNull().default("0"),
  status:          text("status").notNull().default("active"),
  metadata:        jsonb("metadata"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("creator_creator_idx").on(t.creatorId),
  index("creator_handle_idx").on(t.handle),
  index("creator_status_idx").on(t.status),
]);

export const loanRepaymentsTable = pgTable("loan_repayments", {
  id:            text("id").primaryKey(),
  loanId:        text("loan_id").notNull(),
  userId:        text("user_id").notNull(),
  amount:        numeric("amount", { precision: 20, scale: 4 }).notNull(),
  currency:      text("currency").notNull().default("XOF"),
  transactionId: text("transaction_id"),
  scheduledAt:   timestamp("scheduled_at"),
  paidAt:        timestamp("paid_at"),
  status:        text("status").notNull().default("pending"),
  metadata:      jsonb("metadata"),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("repay_loan_idx").on(t.loanId),
  index("repay_user_idx").on(t.userId),
  index("repay_status_idx").on(t.status),
]);

export const purchaseGoalStatusEnum  = pgEnum("purchase_goal_status",  ["open", "funded", "released", "cancelled"]);
export const releaseConditionEnum    = pgEnum("release_condition",     ["goal_reached", "date_reached", "vote"]);

export const tontinePurchaseGoalsTable = pgTable("tontine_purchase_goals", {
  id:                text("id").primaryKey(),
  tontineId:         text("tontine_id").notNull(),
  vendorName:        text("vendor_name").notNull(),
  vendorWalletId:    text("vendor_wallet_id"),
  vendorPhone:       text("vendor_phone"),
  goalAmount:        numeric("goal_amount",   { precision: 20, scale: 4 }).notNull(),
  goalDescription:   text("goal_description").notNull(),
  currentAmount:     numeric("current_amount", { precision: 20, scale: 4 }).notNull().default("0"),
  status:            purchaseGoalStatusEnum("status").notNull().default("open"),
  releaseCondition:  releaseConditionEnum("release_condition").notNull().default("goal_reached"),
  targetDate:        timestamp("target_date"),
  votesRequired:     integer("votes_required"),
  votesReceived:     integer("votes_received").notNull().default(0),
  releasedAt:        timestamp("released_at"),
  createdAt:         timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("pgoal_tontine_idx").on(t.tontineId),
  index("pgoal_status_idx").on(t.status),
]);

export const solidarityClaimUrgencyEnum = pgEnum("solidarity_claim_urgency", ["low", "medium", "high"]);
export const solidarityClaimStatusEnum  = pgEnum("solidarity_claim_status",  ["pending_admin", "approved", "rejected", "disbursed"]);

export const tontineHybridCyclesTable = pgTable("tontine_hybrid_cycles", {
  id:               text("id").primaryKey(),
  tontineId:        text("tontine_id").notNull(),
  round:            integer("round").notNull(),
  totalPool:        numeric("total_pool",        { precision: 20, scale: 4 }).notNull(),
  rotationAmount:   numeric("rotation_amount",   { precision: 20, scale: 4 }).notNull(),
  investmentAmount: numeric("investment_amount", { precision: 20, scale: 4 }).notNull(),
  solidarityAmount: numeric("solidarity_amount", { precision: 20, scale: 4 }).notNull(),
  yieldAmount:      numeric("yield_amount",      { precision: 20, scale: 4 }).notNull(),
  recipientUserId:  text("recipient_user_id"),
  yieldRecipients:  integer("yield_recipients").notNull().default(0),
  metadata:         jsonb("metadata"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("hybrid_cycle_tontine_idx").on(t.tontineId),
  index("hybrid_cycle_round_idx").on(t.round),
]);

export const tontineSolidaryClaimsTable = pgTable("tontine_solidarity_claims", {
  id:          text("id").primaryKey(),
  tontineId:   text("tontine_id").notNull(),
  userId:      text("user_id").notNull(),
  amount:      numeric("amount", { precision: 20, scale: 4 }).notNull(),
  reason:      text("reason").notNull(),
  urgency:     solidarityClaimUrgencyEnum("urgency").notNull().default("low"),
  status:      solidarityClaimStatusEnum("status").notNull().default("pending_admin"),
  autoApproved:boolean("auto_approved").notNull().default(false),
  reviewedBy:  text("reviewed_by"),
  reviewedAt:  timestamp("reviewed_at"),
  disbursedAt: timestamp("disbursed_at"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("solidclaim_tontine_idx").on(t.tontineId),
  index("solidclaim_user_idx").on(t.userId),
  index("solidclaim_status_idx").on(t.status),
]);

export const strategyTargetStatusEnum = pgEnum("strategy_target_status", ["funded", "active", "completed", "defaulted"]);

export const tontineStrategyTargetsTable = pgTable("tontine_strategy_targets", {
  id:               text("id").primaryKey(),
  tontineId:        text("tontine_id").notNull(),
  merchantId:       text("merchant_id").notNull(),
  allocatedAmount:  numeric("allocated_amount",  { precision: 20, scale: 4 }).notNull(),
  purpose:          text("purpose").notNull(),
  performanceScore: numeric("performance_score", { precision: 5, scale: 2 }).notNull().default("0"),
  revenueGenerated: numeric("revenue_generated", { precision: 20, scale: 4 }).notNull().default("0"),
  status:           strategyTargetStatusEnum("status").notNull().default("funded"),
  fundedAt:         timestamp("funded_at"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("strat_tontine_idx").on(t.tontineId),
  index("strat_merchant_idx").on(t.merchantId),
  index("strat_status_idx").on(t.status),
]);

export const schedulerJobsTable = pgTable("scheduler_jobs", {
  id:          text("id").primaryKey(),
  jobType:     text("job_type").notNull(),
  entityId:    text("entity_id").notNull(),
  entityType:  text("entity_type").notNull(),
  scheduledAt: timestamp("scheduled_at").notNull(),
  runAt:       timestamp("run_at"),
  status:      text("status").notNull().default("pending"),
  attempts:    integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  error:       text("error"),
  metadata:    jsonb("metadata"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("sched_type_idx").on(t.jobType),
  index("sched_entity_idx").on(t.entityId),
  index("sched_status_idx").on(t.status),
  index("sched_scheduledat_idx").on(t.scheduledAt),
]);
