# KOWRI V5.0 — African Financial Super-App: Architecture Reference

> **"PayPal + Stripe + Tontine + Community Credit for Africa"**
> Phase 1–7 complete · 151/151 integration tests passing · Production-ready

---

## 1. Platform Overview

KOWRI V5.0 is a full-stack African financial super-app delivered as a pnpm monorepo with:

| Layer | Technology |
|---|---|
| API Server | Node.js + Express + TypeScript |
| Database | PostgreSQL via Drizzle ORM |
| Dashboard | React + Vite |
| Test Suite | Node.js `.mjs` + native `fetch` |

All financial amounts are stored as `numeric(20,4)` in the database and exposed as JavaScript `number` values through the API. IDs are `text` primary keys populated with `crypto.randomUUID()`.

---

## 2. Repository Structure

```
workspace/
├── artifacts/
│   ├── api-server/              # Main backend (port via $PORT env var)
│   │   ├── src/
│   │   │   ├── db/
│   │   │   │   └── schema.ts    # Drizzle schema — single source of truth
│   │   │   ├── lib/             # Service libraries (pure business logic)
│   │   │   │   ├── wallets.ts
│   │   │   │   ├── tontines.ts
│   │   │   │   ├── credit.ts
│   │   │   │   ├── fx.ts
│   │   │   │   ├── aml.ts
│   │   │   │   ├── tontineScheduler.ts   ← Phase 7
│   │   │   │   ├── reputationEngine.ts   ← Phase 7
│   │   │   │   ├── communityFinance.ts   ← Phase 7
│   │   │   │   ├── savingsEngine.ts      ← Phase 7
│   │   │   │   ├── diasporaService.ts    ← Phase 7
│   │   │   │   └── creatorEconomy.ts     ← Phase 7
│   │   │   ├── routes/          # Express routers (one file per domain)
│   │   │   │   ├── index.ts     # Central router registry
│   │   │   │   ├── users.ts
│   │   │   │   ├── wallets.ts
│   │   │   │   ├── tontines.ts
│   │   │   │   ├── credit.ts
│   │   │   │   ├── fx.ts
│   │   │   │   ├── analytics.ts
│   │   │   │   ├── system.ts
│   │   │   │   ├── aml.ts
│   │   │   │   ├── communityFinance.ts   ← Phase 7
│   │   │   │   ├── investmentPools.ts    ← Phase 7
│   │   │   │   ├── insurancePools.ts     ← Phase 7
│   │   │   │   ├── savings.ts            ← Phase 7
│   │   │   │   ├── diaspora.ts           ← Phase 7
│   │   │   │   └── creatorEconomy.ts     ← Phase 7
│   │   │   └── index.ts         # Express app entry point
│   │   ├── test-phase7.mjs      # Phase 7 integration test (151 checks)
│   │   └── drizzle.config.ts
│   └── kowri-dashboard/         # React dashboard (port via $PORT env var)
└── packages/
    └── shared/                  # Shared TypeScript types
```

---

## 3. Database Schema

### 3.1 Core Tables (Phases 1–6)

| Table | Purpose |
|---|---|
| `users` | User profiles — phone, name, country, pin (hashed) |
| `wallets` | Multi-currency wallets (`personal`, `merchant`, `savings`, `tontine`) |
| `transactions` | Immutable ledger for all money movements |
| `tontines` | Tontine group savings circles |
| `tontine_members` | Membership roster + payout order |
| `loans` | Credit facility records |
| `credit_scores` | Per-user credit scoring snapshots |
| `fx_rates` | FX rate cache (source/target pairs) |
| `aml_cases` | Anti-money-laundering case tracking |
| `kyc_documents` | KYC document uploads |
| `merchant_profiles` | Merchant account extensions |
| `payment_links` | One-time and recurring payment links |
| `webhooks` | Event subscription registry |

### 3.2 Phase 7 Tables (Community Finance)

| Table | Purpose |
|---|---|
| `tontine_bids` | Members bidding to receive payout early |
| `tontine_position_listings` | Secondary market listings for tontine positions |
| `reputation_scores` | Multi-factor community reputation snapshots |
| `savings_plans` | Locked savings with maturity dates |
| `investment_pools` | Community investment vehicles |
| `pool_positions` | Investor stakes in investment pools |
| `insurance_pools` | Mutual aid insurance pools |
| `insurance_policies` | Individual policy records |
| `insurance_claims` | Filed claims and adjudication outcomes |
| `remittance_corridors` | Country-pair remittance routing with fee tables |
| `beneficiaries` | Saved recipient profiles for diaspora transfers |
| `recurring_transfers` | Scheduled recurring transfer plans |
| `creator_communities` | Creator-led financial communities |
| `loan_repayments` | Installment repayment tracking |
| `scheduler_jobs` | Platform-wide async job queue |

### 3.3 Wallet Types

```
walletType: "personal" | "merchant" | "savings" | "tontine"
```

Every wallet has `balance` (ledger total) and `availableBalance` (spendable after holds). All monetary mutations go through `processTransfer()` or `processDeposit()` which update both fields atomically.

---

## 4. API Reference

All routes are prefixed `/api`. The server binds to `$PORT` (default 8080 in development).

### 4.1 Identity & Wallets

```
POST   /api/users                  Create user {phone, firstName, lastName, country, pin}
GET    /api/users/:id              Get user profile
POST   /api/wallets                Create wallet
GET    /api/wallets/:id            Get wallet
POST   /api/wallets/:id/deposit    Deposit funds (requires Idempotency-Key header)
POST   /api/wallets/transfer       Transfer between wallets
GET    /api/wallets/:id/transactions  Transaction history
```

### 4.2 Tontines (Phases 1–6)

```
POST   /api/tontines               Create tontine (admin auto-joined as member)
GET    /api/tontines/:id           Get tontine
POST   /api/tontines/:id/join      Join tontine
```

### 4.3 Community Finance — Tontine Advanced (Phase 7)

```
POST   /api/community/tontines/:id/activate   Activate tontine, assign payout order
                                               (auto-creates pool wallet if absent)
POST   /api/community/tontines/:id/members    Add member {userId}
GET    /api/community/tontines/:id/schedule   Payout schedule
POST   /api/community/tontines/:id/bid        Bid to receive payout {userId, bidAmount}
GET    /api/community/tontines/:id/bids       All bids
POST   /api/community/tontines/:id/collect    Collect monthly contributions
POST   /api/community/tontines/:id/payout     Execute payout to current round recipient
POST   /api/community/tontines/:id/list-position   List position for sale {sellerId, askPrice}
GET    /api/community/tontines/:id/market     Open position listings
POST   /api/community/tontines/buy/:listingId  Buy listed position {buyerId}
GET    /api/community/scheduler/jobs          Scheduler job queue
```

### 4.4 Savings Engine (Phase 7)

```
GET    /api/savings/rate                   Current base rate and tier rates
POST   /api/savings/plans                  Lock savings {userId, walletId, amount, days}
GET    /api/savings/plans/:id              Plan details + accrued yield
POST   /api/savings/plans/:id/accrue       Manually trigger yield accrual
POST   /api/savings/plans/:id/break        Early break (returns principal − penalty + yield)
GET    /api/savings/summary                Portfolio summary for a user
GET    /api/savings/plans?userId=          List all plans for a user
```

**Rate tiers:**

| Tier | Days | Rate |
|---|---|---|
| Standard | ≤ 30 | 6% APY |
| Silver | 31–90 | 8% APY |
| Gold | 91–180 | 10% APY |
| Platinum | 181+ | 12% APY |

### 4.5 Investment Pools (Phase 7)

```
POST   /api/pools/investment               Create pool {name, currency, goalAmount, minInvestment}
GET    /api/pools/investment               List pools (pagination, ?status=)
GET    /api/pools/investment/:id           Pool details (NAV, investorCount)
POST   /api/pools/investment/:id/invest    Invest {userId, walletId, amount}
GET    /api/pools/investment/:id/nav       Compute current NAV
GET    /api/pools/investment/:id/positions  Investor positions
```

### 4.6 Insurance Pools (Phase 7)

```
POST   /api/pools/insurance                Create pool {name, currency, premiumAmount, claimLimit}
GET    /api/pools/insurance                List pools
GET    /api/pools/insurance/:id            Pool details
POST   /api/pools/insurance/:id/join       Join pool (pay premium) {userId, walletId}
GET    /api/pools/insurance/:id/policies   All policies
POST   /api/pools/insurance/claims         File claim {poolId, userId, claimAmount, description}
GET    /api/pools/insurance/:id/claims     Claims for pool (?status=)
PATCH  /api/pools/insurance/claims/:id/adjudicate  Approve/deny {adjudicatorId, approved, payoutAmount}
```

### 4.7 Diaspora & Remittances (Phase 7)

```
GET    /api/diaspora/corridors             All corridors (?sourceCountry=)
GET    /api/diaspora/corridors/:id         Corridor detail (fees, FX rate)
POST   /api/diaspora/quote                 Get transfer quotes {sourceCountry, targetCountry, amount}
POST   /api/diaspora/beneficiaries         Add recipient {userId, name, country, accountDetails}
GET    /api/diaspora/beneficiaries         List {userId}
DELETE /api/diaspora/beneficiaries/:id     Remove beneficiary
POST   /api/diaspora/recurring             Schedule recurring transfer
GET    /api/diaspora/recurring             List recurring (?userId=)
PATCH  /api/diaspora/recurring/:id/pause   Pause schedule
PATCH  /api/diaspora/recurring/:id/resume  Resume schedule
DELETE /api/diaspora/recurring/:id         Cancel schedule
POST   /api/diaspora/recurring/run         Process all due recurring transfers
```

### 4.8 Creator Economy (Phase 7)

```
POST   /api/creator/communities            Create community {creatorId, name, handle, currency}
GET    /api/creator/communities            List communities (pagination)
GET    /api/creator/communities/:id        By ID
GET    /api/creator/communities/handle/:h  By handle
POST   /api/creator/communities/:id/join   Join community {userId}
POST   /api/creator/communities/:id/earnings  Record earnings {amount, currency}
GET    /api/creator/dashboard              Creator stats {userId}
PATCH  /api/creator/communities/:id/status  Update status {status}
GET    /api/creator/communities/:id/pools  Investment pools + tontines linked to community
```

**Fee split:** Creator receives 70%, platform retains 30%.

### 4.9 Reputation Engine (Phase 7)

```
POST   /api/community/reputation/:userId/compute  Compute score (analyzes all activity)
GET    /api/community/reputation/:userId          Get latest score + breakdown
```

**Score components (max 100):**

| Factor | Max Points | Source |
|---|---|---|
| Transaction volume | 30 | Wallet transactions |
| Tontine reliability | 25 | On-time contributions |
| Loan repayment | 20 | Repayment history |
| Community engagement | 15 | Tontine + community membership |
| Savings discipline | 10 | Savings plan adherence |

**Tiers:** `bronze` (0–39) · `silver` (40–59) · `gold` (60–79) · `platinum` (80–100)

### 4.10 Credit Scores + Loan Repayments (Phase 7 Extension)

```
POST   /api/credit/scores/:userId/compute  Compute composite credit score
GET    /api/credit/scores/:userId          Latest credit score
POST   /api/credit/repay                   Record repayment {loanId, userId, walletId, amount}
GET    /api/credit/repayments?userId=      Repayment history
```

### 4.11 Platform (Phases 1–6)

```
GET    /api/health                 Service health check
GET    /api/system/health          System diagnostics
GET    /api/system/metrics         Platform metrics
GET    /api/fx/rates               All FX rates
POST   /api/fx/convert             Currency conversion
GET    /api/analytics/overview     Dashboard metrics
GET    /api/aml/cases              AML case list
GET    /api/aml/cases/:id          Case detail
```

---

## 5. Service Library Architecture

Each domain is split into a pure **service library** (no HTTP concerns) and a thin **Express router** that handles validation and serialisation.

### 5.1 `tontineScheduler.ts`

Key exports:
- `assignPayoutOrder(tontineId, model)` — shuffles or fixes rotation order
- `collectContributions(tontineId)` — debits all active members
- `runPayoutCycle(tontineId)` — credits the current round recipient
- `listTontinePosition(tontineId, sellerId, askPrice)` — creates secondary listing
- `buyTontinePosition(listingId, buyerId)` — transfers position ownership (prefers personal wallet with available balance)
- `createSchedulerJob(type, entityId, entityType, scheduledAt, payload)` — enqueues async job

### 5.2 `reputationEngine.ts`

Key exports:
- `computeReputationScore(userId)` — analyses all 5 factors, upserts to `reputation_scores`
- `getReputationScore(userId)` — retrieves latest score or throws 404

### 5.3 `communityFinance.ts`

Key exports:
- `addTontineMember(tontineId, userId)` — with 409 on duplicate
- `getTontineSchedule(tontineId)` — payout rotation schedule
- `submitBid(tontineId, userId, bidAmount)` — early payout bid
- `getTontineBids(tontineId)` — all bids for a round
- `getSchedulerJobs(filter)` — paginated job queue

### 5.4 `savingsEngine.ts`

Key exports:
- `getSavingsRate(amount, days)` — returns APY based on tier
- `createSavingsPlan(userId, walletId, amount, days)` — locks funds from wallet
- `accrueInterest(planId)` — daily yield calculation: `principal × rate / 365`
- `breakSavingsPlan(planId)` — early break with 1.5% annualised penalty, returns net amount
- `getSavingsSummary(userId)` — portfolio view

### 5.5 `diasporaService.ts`

Key exports:
- `seedCorridors()` — pre-seeds 8 pan-African remittance corridors on startup
- `getCorridors(sourceCountry?)` — corridor list with fees
- `getTransferQuotes(sourceCountry, targetCountry, amount)` — multi-provider quotes
- `createBeneficiary / listBeneficiaries / deleteBeneficiary`
- `createRecurringTransfer / processRecurringTransfers`

**Seeded corridors:** GH→NG, NG→GH, SN→CI, CI→SN, KE→TZ, TZ→KE, GH→UK, NG→FR

### 5.6 `creatorEconomy.ts`

Key exports:
- `createCommunity(data)` — with unique handle enforcement (409 on conflict)
- `joinCommunity(communityId, userId)`
- `recordEarnings(communityId, amount, currency)` — splits 70/30
- `getCreatorDashboard(creatorId)` — aggregated stats + linked pools
- `getLinkedPools(communityId)` — investment pools + tontines linked to community

---

## 6. Key Engineering Patterns

### 6.1 Money Mutations

All balance changes go through two utility functions in `wallets.ts`:

```typescript
processDeposit({ walletId, amount, currency, description, idempotencyKey })
processTransfer({ fromWalletId, toWalletId, amount, currency, description })
```

Both update `balance` and `availableBalance` atomically and write an immutable `transactions` row.

### 6.2 Idempotency

Deposit endpoints require an `Idempotency-Key` header. The key is stored on the transaction record and checked before processing to prevent duplicate credits.

### 6.3 ID Generation

```typescript
export const generateId = () => crypto.randomUUID();
```

Used consistently across all INSERT operations. All PKs are `text` columns.

### 6.4 Amount Storage

- **DB storage:** `numeric(20,4)` — stored as `String(amount)` via Drizzle
- **API responses:** parsed back with `Number(row.amount)` before serialisation
- **Never** store floats directly in financial columns

### 6.5 Wallet Selection Priority

When a user has multiple wallets, service libraries pick wallets with this preference:

1. `walletType = "personal"` 
2. Any wallet with `availableBalance > 0`
3. First wallet in result set

### 6.6 Pool Wallet Auto-Creation

When `POST /community/tontines/:id/activate` is called on a tontine that has `walletId = null` (created via the legacy route), the activate handler automatically creates a `tontine`-type wallet owned by the admin and updates the tontine record before proceeding with activation.

### 6.7 Error Conventions

| Status | Meaning |
|---|---|
| 400 | Validation failure (missing fields, business rule violation) |
| 404 | Resource not found |
| 409 | Conflict (duplicate phone, duplicate member, duplicate handle) |
| 500 | Unexpected server error (logged + `{ error: true, message }`) |

All error responses follow `{ error: true, message: string }`.

---

## 7. Phase Delivery Summary

| Phase | Features | Tests |
|---|---|---|
| 1 | Users, Wallets, Deposits, Transfers | ✅ |
| 2 | Merchants, Payment Links, Webhooks | ✅ |
| 3 | Tontines, KYC, Loans | ✅ |
| 4 | Credit Scores, FX, AML | ✅ |
| 5 | Analytics, System Health | ✅ |
| 6 | Platform hardening, regression suite | ✅ |
| 7 | Tontine Scheduler + Secondary Market, Savings Engine, Investment Pools, Insurance Pools, Diaspora/Remittance, Creator Economy, Reputation Engine, Credit Compute, Loan Repayments | ✅ 151/151 |

---

## 8. Running the Platform

```bash
# Install
pnpm install

# Push schema to database
pnpm --filter @workspace/api-server run db:push

# Start API server (development)
pnpm --filter @workspace/api-server run dev

# Run Phase 7 integration tests
cd artifacts/api-server
node test-phase7.mjs
```

---

## 9. Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (managed by Replit) |
| `PORT` | HTTP port (assigned per-artifact by Replit) |

---

*KOWRI V5.0 — Phase 7 Complete. 151/151 integration tests passing.*
