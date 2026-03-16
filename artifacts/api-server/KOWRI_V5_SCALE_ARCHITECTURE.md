# KOWRI V5.0 — Continental Scale Architecture
## The Financial Infrastructure of African Communities

> **Status:** Phase 7 complete · 151/151 integration tests passing  
> **Target:** 10M users · Sub-second P95 latency · 99.99% availability on critical paths  
> **Mission:** PayPal + Stripe + Tontine + Community Credit for Africa

---

# PART 0 — EXECUTIVE SUMMARY

## 0.1 Architecture Vision

KOWRI V5.0 is not a payment app. It is the financial operating system of African communities — digital infrastructure for the savings circles, credit cooperatives, diaspora remittances, and mutual insurance pools that have sustained African economies for centuries, now brought into the digital age with the reliability of a fintech unicorn.

The platform has completed 7 phases of development and has 13 fully operational product lines, validated by 151 integration tests. This document describes what it takes to scale from 100,000 users to 10,000,000 — without rebuilding anything.

**Core principle:** Every improvement extends the existing architecture. Nothing is replaced.

## 0.2 What Already Works (and Why It Matters)

Before identifying what to improve, it is worth documenting what KOWRI already does correctly — because many of these patterns are gaps in far more mature systems:

| Pattern | KOWRI Implementation | Status |
|---|---|---|
| Double-entry ledger | `ledger_entries` table with debit/credit pairs on every mutation | ✅ Live |
| Ledger-derived balances | `getWalletBalance()` SUM(credits)−SUM(debits) from ledger | ✅ Live |
| SELECT FOR UPDATE locking | All transfers lock both wallets before balance check | ✅ Live |
| Consistent locking order | Wallets locked in alphabetical ID order to prevent deadlocks | ✅ Live |
| Idempotency middleware | `requireIdempotencyKey` + `checkIdempotency` on all deposit paths | ✅ Live |
| Persistent event bus | Every event written to `event_log` before emitting | ✅ Live |
| Audit trail | `audit_logs` table written on every financial action | ✅ Live |
| Saga orchestrator | Compensating transactions for multi-step flows | ✅ Live |
| Fraud engine | Post-commit async fraud scoring via `setImmediate` | ✅ Live |
| Reconciliation | `reconcileAllWallets()` comparing stored vs. ledger-derived balances | ✅ Live |
| Rate limiting | Per-wallet velocity limits before any transfer | ✅ Live |
| Multi-region | 4 regions, 9 read replicas, DNS failover | ✅ Live |

## 0.3 Key Gaps to Address for 10M Scale

The existing system is architecturally correct. The gaps are about **depth, hardening, and throughput:**

1. **Idempotency coverage** — Deposits are protected. Transfers, tontine contributions, and insurance payouts are not yet covered by the idempotency middleware.

2. **Event outbox** — Events are written to the DB before emitting, but within the same connection (not the same transaction). A commit succeeding after event write failure could cause event loss.

3. **CQRS read path** — All reads and writes share the same DB connection pool. At 10M users, analytics queries will starve transactional workloads.

4. **Risk engine** — Fraud scoring is reactive (post-commit). A real-time risk gate before payment execution is needed for high-value flows.

5. **Observability** — Metrics, tracing, and alerts exist but are not structured for operational alerting. No P0/P1/P2 alert taxonomy.

6. **African infrastructure** — No offline queue, USSD fallback, or low-bandwidth optimisation.

## 0.4 Scalability Targets

```
                    Current     Phase 8 Target
────────────────────────────────────────────────
Peak TPS            ~200        5,000
Users               100K        10M
Wallets             300K        30M
P95 API latency     ~120ms      <200ms
P99 API latency     ~400ms      <800ms
Payment success     98.5%       99.5%
Uptime (critical)   99.9%       99.99%
RTO                 ~15min      <2min
RPO                 ~5min       <30sec
```

---

# PART 1 — COMPLETE PRODUCT MODULES

## 1.1 Current Product Surface (All Implemented)

All 13 product lines are live and tested:

```
┌─────────────────────────────────────────────────────────────────┐
│                    KOWRI PRODUCT SURFACE                        │
├──────────────────────────┬──────────────────────────────────────┤
│  KOWRI WALLET            │  Consumer financial app               │
│  - User onboarding       │  - Multi-currency wallets             │
│  - P2P transfers         │  - QR payments                        │
│  - Transaction history   │  - Diaspora wallets                   │
├──────────────────────────┼──────────────────────────────────────┤
│  KOWRI MERCHANT          │  Business payment infrastructure      │
│  - Merchant onboarding   │  - Payment links                      │
│  - QR acceptance         │  - Settlement tracking                │
│  - Webhook notifications │  - Merchant dashboard                 │
├──────────────────────────┼──────────────────────────────────────┤
│  KOWRI COMMUNITY FINANCE │  African community financial tools    │
│  - Digital tontines      │  - Tontine scheduler                  │
│  - Payout rotation       │  - Secondary position market          │
│  - Reputation engine     │  - Community credit scoring           │
│  - Micro-loans           │  - Investment pools                   │
│  - Insurance pools       │  - Locked savings                     │
│  - Diaspora remittance   │  - Creator economy                    │
├──────────────────────────┼──────────────────────────────────────┤
│  KOWRI DEVELOPER API     │  Banking-as-a-Service                 │
│  - API key management    │  - Rate limiting                      │
│  - Webhook system        │  - Sandbox environment                │
│  - Usage analytics       │  - Developer dashboard                │
└──────────────────────────┴──────────────────────────────────────┘
```

## 1.2 API Surface by Domain

The complete API surface (all routes live):

```
Domain              Base Path                  Methods
──────────────────────────────────────────────────────────────────
Identity            /api/users                 POST, GET
Wallets             /api/wallets               POST, GET, PATCH
Transactions        /api/transactions          GET
Tontines (core)     /api/tontines              POST, GET
Tontines (adv.)     /api/community/tontines    POST, GET, PATCH
Savings             /api/savings               POST, GET
Investment Pools    /api/pools/investment      POST, GET
Insurance Pools     /api/pools/insurance       POST, GET, PATCH
Diaspora            /api/diaspora              POST, GET, PATCH, DELETE
Creator Economy     /api/creator               POST, GET, PATCH
Reputation          /api/community/reputation  POST, GET
Credit              /api/credit                POST, GET
Merchants           /api/merchants             POST, GET
Payment Links       /api/payment-links         POST, GET
FX                  /api/fx                    POST, GET
AML                 /api/aml                   GET, PATCH
Analytics           /api/analytics             GET
System              /api/system                GET
Admin               /api/admin                 GET, POST, PATCH
Developer           /api/developer             POST, GET
Settlements         /api/settlements           POST, GET
Scheduler           /api/community/scheduler   GET
```

---

# PART 2 — CORRECTION OF CRITICAL STRUCTURAL FLAWS

## FLAW 1 — Ledger Integrity

### Current State

The ledger foundation is correct and production-quality:

```typescript
// walletService.ts — getWalletBalance()
// Balance is ALWAYS derived from the ledger, never from a stored column
const balance = SUM(ledger_entries.credit_amount) - SUM(ledger_entries.debit_amount)
  WHERE account_id = wallet_id AND account_type = 'wallet'
```

The `syncWalletBalance()` function runs inside the same database transaction as every monetary mutation, meaning the wallet's stored `balance` column is always synchronised with the ledger before the transaction commits. The `reconcileAllWallets()` function compares stored vs. derived for all wallets.

### Gap

`reconcileAllWallets()` is callable on demand but is not on a schedule. There is no alerting when a discrepancy is found. Admin endpoint coverage is partial.

### Required Implementation: LedgerIntegrityService

**New file:** `src/lib/ledgerIntegrity.ts`

```typescript
// PSEUDOCODE — extend existing reconcileAllWallets()
export async function runLedgerIntegrityCheck(
  scope: "all" | "high_activity" = "all"
): Promise<IntegrityReport> {
  const wallets = scope === "high_activity"
    ? await getWalletsWithRecentActivity(hours = 1)
    : await db.select().from(walletsTable);

  const discrepancies: Discrepancy[] = [];

  for (const wallet of wallets) {
    const derived = await getWalletBalance(wallet.id);   // from ledger
    const stored  = Number(wallet.balance);              // from wallets table
    const delta   = Math.abs(stored - derived);

    if (delta > 0.0001) {                               // 4dp tolerance
      discrepancies.push({ walletId: wallet.id, stored, derived, delta });

      // AUTO-CORRECT: sync wallet to ledger truth
      await syncWalletBalance(wallet.id);

      // AUDIT: write correction record
      await audit({
        action: "reconciliation.fixed",
        entity: "wallet",
        entityId: wallet.id,
        metadata: { stored, derived, delta, correctedAt: new Date() }
      });

      // ALERT: trigger P0 alert if delta > threshold
      if (delta > 100) {
        await triggerAlert("P0", "LEDGER_DISCREPANCY", {
          walletId: wallet.id, stored, derived, delta
        });
      }
    }
  }

  await audit({
    action: "reconciliation.run",
    entity: "platform",
    entityId: "global",
    metadata: { scope, walletsChecked: wallets.length, discrepancies: discrepancies.length }
  });

  return { walletsChecked: wallets.length, discrepancies };
}
```

**Scheduler (add to app startup):**

```typescript
// Hourly: high-activity wallets
setInterval(() => runLedgerIntegrityCheck("high_activity"), 60 * 60 * 1000);

// Daily at 02:00 UTC: all wallets
cron("0 2 * * *", () => runLedgerIntegrityCheck("all"));
```

**Admin endpoint (extend `system.ts`):**

```
GET  /api/admin/integrity/check?scope=high_activity
GET  /api/admin/integrity/check?scope=all
GET  /api/admin/integrity/report?since=2024-01-01
```

### Database Constraints to Add

```sql
-- Prevent negative balances at DB level
ALTER TABLE wallets
  ADD CONSTRAINT chk_wallet_balance_non_negative
  CHECK (CAST(balance AS NUMERIC) >= 0);

-- Ensure ledger entries always have exactly one side non-zero
ALTER TABLE ledger_entries
  ADD CONSTRAINT chk_ledger_one_side
  CHECK (
    (CAST(debit_amount AS NUMERIC) > 0 AND CAST(credit_amount AS NUMERIC) = 0)
    OR
    (CAST(credit_amount AS NUMERIC) > 0 AND CAST(debit_amount AS NUMERIC) = 0)
  );

-- Prevent orphan ledger entries
ALTER TABLE ledger_entries
  ADD CONSTRAINT fk_ledger_transaction
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
  ON DELETE RESTRICT;

-- Index for reconciliation query performance
CREATE INDEX CONCURRENTLY idx_ledger_account_type
  ON ledger_entries(account_id, account_type);
```

---

## FLAW 2 — Idempotency Coverage

### Current State

The idempotency middleware already exists and is production-quality:

```typescript
// middleware/idempotency.ts — already implemented
requireIdempotencyKey  // enforces header presence
checkIdempotency       // returns cached response on replay
```

The `idempotency_keys` table stores request/response pairs with endpoint scoping.

### Gap

The middleware is only applied to `POST /wallets/:id/deposit`. The following financial endpoints are not yet protected:

- `POST /wallets/transfer`
- `POST /community/tontines/:id/collect`
- `POST /community/tontines/:id/payout`
- `POST /pools/insurance/:id/join`
- `PATCH /pools/insurance/claims/:id/adjudicate`
- `POST /savings/plans`
- `POST /credit/repay`

### Required Change: Apply Middleware to All Financial Routes

```typescript
// routes/wallets.ts — add to transfer route
router.post(
  "/transfer",
  requireIdempotencyKey,
  checkIdempotency,
  async (req, res, next) => { ... }
);

// routes/communityFinance.ts — collect and payout
router.post(
  "/tontines/:tontineId/collect",
  requireIdempotencyKey,
  checkIdempotency,
  async (req, res, next) => { ... }
);

router.post(
  "/tontines/:tontineId/payout",
  requireIdempotencyKey,
  checkIdempotency,
  async (req, res, next) => { ... }
);
```

**TTL management — add to schema:**

```sql
-- Add expiry to idempotency_keys
ALTER TABLE idempotency_keys
  ADD COLUMN expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours';

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);
```

**Cleanup job:**

```typescript
// Runs every 6 hours — purge expired keys
setInterval(async () => {
  await db.delete(idempotencyKeysTable)
    .where(lt(idempotencyKeysTable.expiresAt, new Date()));
}, 6 * 60 * 60 * 1000);
```

### Idempotency Processing States (Enhancement)

The current implementation stores the final response but does not handle concurrent duplicate requests during processing. Add status tracking:

```typescript
// Enhanced flow — prevents race condition on concurrent duplicates
async function processWithIdempotency(key, endpoint, handler) {
  // 1. Try to reserve the key (INSERT ... ON CONFLICT DO NOTHING)
  const reserved = await reserveIdempotencyKey(key, endpoint);  // sets status='processing'

  if (!reserved) {
    // Key exists — wait for completion or return cached
    const existing = await waitForCompletion(key, endpoint, timeout=5000);
    if (existing.status === 'completed') return existing.responseBody;
    if (existing.status === 'processing') throw new Error("Request still processing");
  }

  try {
    const result = await handler();
    await markIdempotencyComplete(key, endpoint, result);
    return result;
  } catch (err) {
    await markIdempotencyFailed(key, endpoint, err.message);
    throw err;
  }
}
```

---

## FLAW 3 — Race Condition Protection

### Current State

The existing `processTransfer()` implementation already does this correctly:

```typescript
// walletService.ts — already implemented
BEGIN TRANSACTION;
  SELECT id FROM wallets
    WHERE id IN ($fromWalletId, $toWalletId)
    ORDER BY id                    -- alphabetical order prevents deadlocks
    FOR UPDATE;                    -- exclusive row lock

  // Balance check AFTER lock acquisition
  SUM(credits) - SUM(debits) FROM ledger_entries;

  IF balance < amount: throw "Insufficient funds";

  INSERT INTO transactions ...
  INSERT INTO ledger_entries (debit), (credit) ...
  UPDATE wallets SET balance = derived ...
COMMIT;
```

This pattern is correct. It prevents all three race conditions:
- **TOCTOU:** Balance verified after lock, not before
- **Deadlock:** Consistent alphabetical lock ordering
- **Phantom reads:** Row-level exclusive lock held for transaction duration

### Gap

The pattern is only applied consistently in `walletService.ts`. Some Phase 7 service libraries (e.g., `savingsEngine.ts`, `insurancePools.ts`) call `processTransfer()` correctly but their own DB mutations around it are not always transactional.

### Required: SafeWalletMutationService

Every service that combines a wallet mutation with a non-wallet DB write must wrap both in the same transaction:

```typescript
// PSEUDOCODE — pattern to apply across Phase 7 services
export async function createSavingsPlanSafe(params: SavingsPlanParams) {
  return db.transaction(async (tx) => {
    // 1. Lock the wallet FIRST
    await tx.execute(sql`
      SELECT id FROM wallets WHERE id = ${params.walletId} FOR UPDATE
    `);

    // 2. Check available balance from ledger
    const balance = await getLedgerBalance(params.walletId, tx);
    if (balance < params.amount) throw new Error("Insufficient funds");

    // 3. Write ledger entries (debit from wallet)
    await tx.insert(ledgerEntriesTable).values([debitEntry, creditEntry]);

    // 4. Sync wallet balance
    await syncWalletBalance(params.walletId, tx);

    // 5. Create savings plan record (inside same transaction)
    const [plan] = await tx.insert(savingsPlansTable).values(planData).returning();

    // 6. Write to event_outbox (inside same transaction)
    await tx.insert(eventOutboxTable).values({
      aggregateType: "savings_plan",
      aggregateId: plan.id,
      eventType: "savings.plan.created",
      payload: { planId: plan.id, userId: params.userId, amount: params.amount }
    });

    return plan;
  });
  // If ANY step fails, ALL steps roll back — guaranteed
}
```

### Deadlock Retry Logic

Add exponential backoff retry around all financial transactions:

```typescript
async function withDeadlockRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isDeadlock = err.code === "40P01";        // PostgreSQL deadlock code
      const isSerializable = err.code === "40001";    // serialization failure
      const retriable = isDeadlock || isSerializable;

      if (retriable && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 50 + Math.random() * 50;
        console.warn(`[DB] Deadlock on attempt ${attempt}, retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
}

// Usage:
const result = await withDeadlockRetry(() => processTransfer(params));
```

---

## FLAW 4 — Database Overload (CQRS)

### Current State

A single PostgreSQL instance with a shared connection pool serves all workloads: transactional writes, user-facing reads, admin analytics, reconciliation, and fraud analysis. At 10M users this becomes a bottleneck.

### Gap Analysis

| Query Type | Current | Problem at Scale |
|---|---|---|
| Transfer write | Primary DB | Acceptable |
| Transaction history | Primary DB | Read amplification on primary |
| Admin dashboard | Primary DB | Analytics joins block OLTP |
| Reconciliation | Primary DB | Table scans compete with inserts |
| Fraud analysis | Primary DB | Full-table aggregations |
| Tontine scheduler | Primary DB | Batch jobs contend with transfers |

### CQRS Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     WRITE PATH (OLTP)                           │
│                                                                 │
│  Client → API → processTransfer()                               │
│               → db.transaction() [PRIMARY DB]                   │
│               → ledger_entries INSERT                           │
│               → wallets UPDATE                                  │
│               → event_outbox INSERT                             │
│               → COMMIT                                          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ event_outbox worker
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EVENT PIPELINE                               │
│                                                                 │
│  OutboxWorker polls event_outbox WHERE status='pending'         │
│  → Publishes to eventBus                                        │
│  → Updates event_outbox SET status='published'                  │
└──────────┬────────────────────────────────────────┬────────────┘
           │                                        │
           ▼                                        ▼
┌──────────────────────┐              ┌─────────────────────────┐
│   READ DATABASE      │              │  ANALYTICS DATABASE     │
│   (Read Replica)     │              │  (Separate schema)      │
│                      │              │                         │
│  - tx_history view   │              │  - daily_volumes        │
│  - wallet_summary    │              │  - user_cohorts         │
│  - user_activity     │              │  - fraud_features       │
│  - mobile app reads  │              │  - tontine_analytics    │
└──────────────────────┘              └─────────────────────────┘
```

### Read Replica Configuration

```typescript
// db/index.ts — enhanced with read replica routing
const writeDb = drizzle(primaryConnection);
const readDb  = drizzle(replicaConnection);

export function getDb(intent: "write" | "read" = "write") {
  return intent === "write" ? writeDb : readDb;
}

// Usage in route handlers:
// Transactional: getDb("write").transaction(...)
// History queries: getDb("read").select().from(transactionsTable)...
```

### Read-Optimised Views (Materialised)

```sql
-- Materialised view: user wallet summary (refreshed every 60s)
CREATE MATERIALIZED VIEW wallet_summary AS
SELECT
  w.user_id,
  w.id AS wallet_id,
  w.currency,
  w.wallet_type,
  COALESCE(SUM(CAST(le.credit_amount AS NUMERIC)), 0) -
  COALESCE(SUM(CAST(le.debit_amount  AS NUMERIC)), 0) AS ledger_balance,
  w.balance AS stored_balance,
  COUNT(DISTINCT t.id) AS transaction_count,
  MAX(t.created_at) AS last_transaction_at
FROM wallets w
LEFT JOIN ledger_entries le ON le.account_id = w.id AND le.account_type = 'wallet'
LEFT JOIN transactions t ON (t.from_wallet_id = w.id OR t.to_wallet_id = w.id)
GROUP BY w.user_id, w.id, w.currency, w.wallet_type, w.balance;

CREATE INDEX ON wallet_summary(user_id);
CREATE INDEX ON wallet_summary(wallet_id);

-- Refresh every minute via pg_cron or application timer
```

### Partitioning Strategy

```sql
-- Partition ledger_entries by month (most queried by date range)
CREATE TABLE ledger_entries (
  id TEXT,
  transaction_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
  -- ... other columns
) PARTITION BY RANGE (created_at);

CREATE TABLE ledger_entries_2024_01 PARTITION OF ledger_entries
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE ledger_entries_2024_02 PARTITION OF ledger_entries
  FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Auto-create future partitions monthly
```

### Cache Layer (Redis-compatible)

```typescript
// lib/cache.ts
interface CacheConfig {
  walletBalance: { ttl: 5 };      // 5 seconds — must be near-realtime
  fxRates: { ttl: 300 };          // 5 minutes — rates change slowly
  userProfile: { ttl: 3600 };     // 1 hour — profiles change rarely
  corridors: { ttl: 86400 };      // 24 hours — corridor config is static
}

// Use in-process Map cache for single-instance
// Use Redis/Valkey for multi-instance deployment
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value as T);

  return fn().then(value => {
    cache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    return value;
  });
}
```

---

# PART 3 — FINTECH UNICORN ARCHITECTURAL PATTERNS

## PATTERN 1 — Event-Driven Architecture

### Current State

The event bus (`eventBus.ts`) already:
- Persists all events to `event_log` table before emitting
- Dispatches webhooks asynchronously via `setImmediate`
- Has typed event registry (`KowriEventType`)
- Logs all events to console for tracing

### Gap

Events are emitted within the same DB connection as the business transaction but NOT inside the same DB transaction. If the commit succeeds but the event write fails (transient error), the event is lost.

### Required: Transaction Outbox Pattern

This is the single most impactful reliability improvement in the entire roadmap.

**New table:**

```sql
CREATE TABLE event_outbox (
  id          TEXT PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,           -- 'wallet', 'tontine', 'loan'
  aggregate_id    TEXT NOT NULL,           -- entity UUID
  event_type      TEXT NOT NULL,           -- 'wallet.credited'
  payload         JSONB NOT NULL,
  status          TEXT DEFAULT 'pending',  -- 'pending' | 'published' | 'failed'
  retry_count     INTEGER DEFAULT 0,
  created_at      TIMESTAMP DEFAULT NOW(),
  published_at    TIMESTAMP,
  next_retry_at   TIMESTAMP DEFAULT NOW(),
  last_error      TEXT
);

CREATE INDEX idx_outbox_pending ON event_outbox(status, next_retry_at)
  WHERE status IN ('pending', 'failed');
```

**Write pattern (inside transaction):**

```typescript
// Every financial mutation adds to outbox IN THE SAME DB TRANSACTION
await db.transaction(async (tx) => {
  // 1. Ledger entries
  await tx.insert(ledgerEntriesTable).values([debit, credit]);

  // 2. Wallet balance sync
  await syncWalletBalance(walletId, tx);

  // 3. Outbox entry — committed atomically with the financial data
  await tx.insert(eventOutboxTable).values({
    id: generateId(),
    aggregateType: "wallet",
    aggregateId: walletId,
    eventType: "wallet.credited",
    payload: { walletId, amount, currency, txId }
  });
  // If commit fails: nothing published. If commit succeeds: outbox guaranteed.
});
```

**Background worker:**

```typescript
// lib/outboxWorker.ts — runs every 500ms
export async function processOutbox(): Promise<void> {
  const pending = await db
    .select()
    .from(eventOutboxTable)
    .where(and(
      inArray(eventOutboxTable.status, ["pending", "failed"]),
      lte(eventOutboxTable.nextRetryAt, new Date()),
      lt(eventOutboxTable.retryCount, 5)
    ))
    .limit(100)
    .for("update", { skipLocked: true });  // prevent duplicate processing

  for (const event of pending) {
    try {
      await eventBus.publish(event.eventType, event.payload as any);
      await db.update(eventOutboxTable)
        .set({ status: "published", publishedAt: new Date() })
        .where(eq(eventOutboxTable.id, event.id));
    } catch (err: any) {
      const nextRetry = new Date(Date.now() + Math.pow(2, event.retryCount) * 1000);
      await db.update(eventOutboxTable)
        .set({
          status: event.retryCount >= 4 ? "dead_letter" : "failed",
          retryCount: event.retryCount + 1,
          nextRetryAt: nextRetry,
          lastError: err.message
        })
        .where(eq(eventOutboxTable.id, event.id));
    }
  }
}

// Start worker:
setInterval(processOutbox, 500);
```

**Complete event taxonomy:**

```typescript
type FinancialEvent =
  | "wallet.created"
  | "wallet.credited"
  | "wallet.debited"
  | "transaction.created"
  | "transaction.completed"
  | "transaction.failed"
  | "tontine.created"
  | "tontine.joined"
  | "tontine.contribution.collected"
  | "tontine.payout.executed"
  | "tontine.position.listed"
  | "tontine.position.sold"
  | "loan.disbursed"
  | "loan.repaid"
  | "loan.defaulted"
  | "insurance.policy.created"
  | "insurance.claim.filed"
  | "insurance.claim.approved"
  | "insurance.claim.denied"
  | "savings.plan.created"
  | "savings.plan.matured"
  | "savings.plan.broken"
  | "investment.position.created"
  | "remittance.sent"
  | "remittance.delivered"
  | "creator.earnings.distributed"
  | "reputation.score.computed"
  | "fraud.alert.triggered"
  | "aml.case.opened";
```

---

## PATTERN 2 — Risk Engine

### Current State

`fraudEngine.ts` runs post-commit via `setImmediate` — it scores transactions but cannot block them.

### Gap

No pre-payment risk gate for high-value or high-risk transactions.

### Required: Pre-Payment Risk Gate

```typescript
// lib/riskEngine.ts — extends existing fraudEngine.ts

export interface RiskDecision {
  score: number;           // 0–100
  action: "allow" | "review" | "block";
  reasons: string[];
  requiresMFA?: boolean;
}

export async function evaluateTransactionRisk(params: {
  fromWalletId: string;
  toWalletId: string;
  amount: number;
  currency: string;
  deviceId?: string;
  ipAddress?: string;
}): Promise<RiskDecision> {
  const reasons: string[] = [];
  let score = 0;

  // Factor 1 — Velocity check (last 60 min)
  const recentCount = await countTransactionsLastHour(params.fromWalletId);
  if (recentCount > 10) { score += 30; reasons.push("HIGH_VELOCITY"); }

  // Factor 2 — Amount anomaly (vs. 90-day average)
  const avgAmount = await getAverageTransactionAmount(params.fromWalletId, days=90);
  if (params.amount > avgAmount * 5) { score += 25; reasons.push("AMOUNT_ANOMALY"); }

  // Factor 3 — New account risk (account < 7 days old)
  const accountAge = await getAccountAgeDays(params.fromWalletId);
  if (accountAge < 7) { score += 20; reasons.push("NEW_ACCOUNT"); }

  // Factor 4 — Counterparty risk
  const counterpartyScore = await getWalletRiskScore(params.toWalletId);
  if (counterpartyScore > 70) { score += 15; reasons.push("RISKY_COUNTERPARTY"); }

  // Factor 5 — Device/IP risk (if available)
  if (params.deviceId) {
    const deviceRisk = await getDeviceRiskScore(params.deviceId);
    if (deviceRisk > 70) { score += 10; reasons.push("RISKY_DEVICE"); }
  }

  // Decision thresholds
  const action: RiskDecision["action"] =
    score >= 80 ? "block" :
    score >= 50 ? "review" :
    "allow";

  return { score, action, reasons, requiresMFA: score >= 50 };
}
```

**Integration in processTransfer:**

```typescript
// walletService.ts — add before transaction lock
if (!skipFraudCheck) {
  const risk = await evaluateTransactionRisk({
    fromWalletId, toWalletId, amount, currency, ipAddress
  });

  if (risk.action === "block") {
    await audit({ action: "transaction.blocked", ... });
    throw new RiskBlockedError(`Transaction blocked: ${risk.reasons.join(", ")}`);
  }

  if (risk.action === "review") {
    // Allow but flag for manual review
    await createAmlCase({ walletId: fromWalletId, riskScore: risk.score, reasons: risk.reasons });
  }
}
```

---

## PATTERN 3 — Complete Observability

### Current State

`metrics.ts` exists and records timing data. `tracer.ts` provides distributed trace IDs. Console logging is structured per-service.

### Gap

No alerting rules, no dashboard queries, no P0/P1/P2 taxonomy.

### Required: Alert Taxonomy

```typescript
// lib/alertManager.ts
type AlertSeverity = "P0" | "P1" | "P2";

interface Alert {
  severity: AlertSeverity;
  type: string;
  message: string;
  context: Record<string, unknown>;
  timestamp: Date;
}

const ALERT_THRESHOLDS = {
  // P0 — CRITICAL: requires immediate action
  ledger_discrepancy_delta:    { severity: "P0", threshold: 0.01  }, // any discrepancy
  payment_success_rate_min:    { severity: "P0", threshold: 0.95  }, // < 95% success
  api_error_rate_max:          { severity: "P0", threshold: 0.05  }, // > 5% error rate
  transaction_blocked_burst:   { severity: "P0", threshold: 10    }, // 10+ blocks/min

  // P1 — WARNING: investigate within 30 minutes
  reconciliation_delay_hours:  { severity: "P1", threshold: 1     },
  outbox_queue_depth:          { severity: "P1", threshold: 10000 },
  p99_latency_ms:              { severity: "P1", threshold: 2000  },
  fraud_alert_burst:           { severity: "P1", threshold: 50    }, // alerts/hour

  // P2 — INFO: investigate within 24 hours
  new_user_drop_pct:           { severity: "P2", threshold: 0.20  }, // 20% drop
  corridor_failure_rate:       { severity: "P2", threshold: 0.10  }, // 10% failures
};

export async function triggerAlert(
  severity: AlertSeverity,
  type: string,
  context: Record<string, unknown>
): Promise<void> {
  const alert: Alert = { severity, type, message: formatMessage(type, context), context, timestamp: new Date() };

  // Write to audit log
  await audit({ action: "reconciliation.fixed", entity: "alert", entityId: type, metadata: context });

  // Console (existing behaviour)
  console.error(`[ALERT:${severity}] ${alert.message}`, context);

  // Future: POST to PagerDuty / Slack / OpsGenie
}
```

**Essential metrics to expose:**

```
Financial Metrics:
  kowri_transaction_total{type, status, currency}       Counter
  kowri_transaction_amount_sum{type, currency}          Counter
  kowri_ledger_discrepancy_total                        Counter
  kowri_fraud_block_total{reason}                       Counter

System Metrics:
  kowri_api_latency_ms{route, method, status}           Histogram (P50/P95/P99)
  kowri_db_query_ms{table, operation}                   Histogram
  kowri_outbox_queue_depth                              Gauge
  kowri_active_connections                              Gauge

Business Metrics:
  kowri_active_wallets_total{type, currency}            Gauge
  kowri_tontines_active_total                           Gauge
  kowri_loans_outstanding_total{currency}               Gauge
  kowri_new_users_daily                                 Counter
```

---

## PATTERN 4 — Financial Audit Trail

### Current State

`auditLogger.ts` writes to `audit_logs` with action, entity, entityId, actor, metadata, and timestamp. It is already append-only (no UPDATE/DELETE operations ever called on it).

### Gap

The `AuditAction` type is too narrow — it covers only 8 actions. It needs to cover all 24 financial event types. The schema is missing `before_state`, `after_state`, and `ip_address`.

### Required Schema Enhancement

```sql
-- Add missing columns to existing audit_logs table
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS before_state  JSONB,
  ADD COLUMN IF NOT EXISTS after_state   JSONB,
  ADD COLUMN IF NOT EXISTS ip_address    TEXT,
  ADD COLUMN IF NOT EXISTS request_id    TEXT,
  ADD COLUMN IF NOT EXISTS actor_type    TEXT DEFAULT 'system';

-- Partition by month for query performance
-- (apply to existing table via CREATE TABLE ... PARTITION BY on next major migration)

-- Index for compliance queries
CREATE INDEX CONCURRENTLY idx_audit_entity_time
  ON audit_logs(entity, entity_id, timestamp DESC);

CREATE INDEX CONCURRENTLY idx_audit_actor_time
  ON audit_logs(actor, timestamp DESC);
```

**Extend AuditAction union:**

```typescript
export type AuditAction =
  // existing
  | "transaction.created" | "transaction.state_changed"
  | "ledger.entry_written" | "wallet.balance_synced"
  | "reconciliation.run" | "reconciliation.fixed"
  | "admin.patch_tontines" | "idempotency.replayed"
  // new — financial
  | "wallet.created" | "wallet.frozen" | "wallet.closed"
  | "transfer.initiated" | "transfer.completed" | "transfer.blocked"
  | "deposit.completed" | "withdrawal.completed"
  | "loan.disbursed" | "loan.repaid" | "loan.defaulted"
  | "tontine.created" | "tontine.activated" | "tontine.payout"
  | "insurance.claim.filed" | "insurance.claim.adjudicated"
  | "savings.plan.created" | "savings.plan.broken"
  | "user.kyc.submitted" | "user.kyc.approved"
  // new — compliance
  | "aml.case.opened" | "aml.case.escalated"
  | "risk.transaction.blocked" | "risk.alert.triggered"
  | "fraud.alert.triggered";
```

---

# PART 4 — DATABASE SCHEMAS

## 4.1 New Tables for Scale

```sql
-- ─────────────────────────────────────────────
-- EVENT OUTBOX (Transaction Outbox Pattern)
-- ─────────────────────────────────────────────
CREATE TABLE event_outbox (
  id             TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'pending',
  retry_count    INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  published_at   TIMESTAMP,
  next_retry_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  last_error     TEXT,
  CONSTRAINT chk_outbox_status
    CHECK (status IN ('pending', 'published', 'failed', 'dead_letter'))
);
CREATE INDEX idx_outbox_pending
  ON event_outbox(status, next_retry_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX idx_outbox_aggregate
  ON event_outbox(aggregate_type, aggregate_id);


-- ─────────────────────────────────────────────
-- RISK SCORES (Pre-Payment Risk Engine)
-- ─────────────────────────────────────────────
CREATE TABLE risk_scores (
  id            TEXT PRIMARY KEY,
  wallet_id     TEXT NOT NULL REFERENCES wallets(id),
  score         INTEGER NOT NULL DEFAULT 0,
  action        TEXT NOT NULL DEFAULT 'allow',
  reasons       TEXT[] DEFAULT '{}',
  transaction_id TEXT,
  amount        NUMERIC(20,4),
  currency      TEXT,
  computed_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_risk_score_range CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT chk_risk_action CHECK (action IN ('allow', 'review', 'block'))
);
CREATE INDEX idx_risk_wallet ON risk_scores(wallet_id, computed_at DESC);
CREATE INDEX idx_risk_action ON risk_scores(action) WHERE action IN ('review', 'block');


-- ─────────────────────────────────────────────
-- INTEGRITY REPORTS (Reconciliation Audit)
-- ─────────────────────────────────────────────
CREATE TABLE integrity_reports (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL DEFAULT 'all',
  wallets_checked     INTEGER NOT NULL DEFAULT 0,
  discrepancies_found INTEGER NOT NULL DEFAULT 0,
  total_delta         NUMERIC(20,4) DEFAULT 0,
  corrections_made    INTEGER NOT NULL DEFAULT 0,
  duration_ms         INTEGER,
  run_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  triggered_by        TEXT DEFAULT 'scheduled'
);


-- ─────────────────────────────────────────────
-- OFFLINE QUEUE (African Connectivity)
-- ─────────────────────────────────────────────
CREATE TABLE offline_queue (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  operation    TEXT NOT NULL,              -- 'transfer' | 'deposit' | 'tontine_bid'
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP,
  error        TEXT,
  CONSTRAINT chk_offline_status
    CHECK (status IN ('queued', 'processing', 'completed', 'failed'))
);
CREATE INDEX idx_offline_user ON offline_queue(user_id, status);
CREATE INDEX idx_offline_status ON offline_queue(status, created_at)
  WHERE status = 'queued';


-- ─────────────────────────────────────────────
-- USSD SESSIONS (African Mobile Access)
-- ─────────────────────────────────────────────
CREATE TABLE ussd_sessions (
  id           TEXT PRIMARY KEY,
  phone        TEXT NOT NULL,
  session_id   TEXT NOT NULL UNIQUE,
  state        TEXT NOT NULL DEFAULT 'MAIN_MENU',
  context      JSONB DEFAULT '{}',
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMP NOT NULL DEFAULT NOW() + INTERVAL '3 minutes'
);
CREATE INDEX idx_ussd_session ON ussd_sessions(session_id);
CREATE INDEX idx_ussd_expires ON ussd_sessions(expires_at);


-- ─────────────────────────────────────────────
-- ALERT LOG (Operational Alerting)
-- ─────────────────────────────────────────────
CREATE TABLE alert_log (
  id         TEXT PRIMARY KEY,
  severity   TEXT NOT NULL,         -- 'P0' | 'P1' | 'P2'
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  context    JSONB DEFAULT '{}',
  resolved   BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMP,
  CONSTRAINT chk_alert_severity CHECK (severity IN ('P0', 'P1', 'P2'))
);
CREATE INDEX idx_alert_severity_unresolved
  ON alert_log(severity, created_at DESC) WHERE resolved = FALSE;
```

## 4.2 Schema Migrations

All schema changes use `pnpm --filter @workspace/api-server run db:push` with the Drizzle schema. Never write raw ALTER TABLE unless adding constraints/indexes to existing tables, which is safe to do with `CONCURRENTLY`.

**Migration sequence:**

```bash
# Step 1 — Add new tables (backward compatible, no data change)
pnpm --filter @workspace/api-server run db:push

# Step 2 — Add indexes concurrently (online, no table lock)
psql $DATABASE_URL -c "CREATE INDEX CONCURRENTLY idx_outbox_pending ON event_outbox(status, next_retry_at) WHERE status IN ('pending', 'failed');"

# Step 3 — Add constraints to existing tables (requires brief lock)
# Schedule during maintenance window or low-traffic period
psql $DATABASE_URL -c "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before_state JSONB;"

# Step 4 — Backfill (if needed) using batched UPDATE to avoid long locks
# Process 1000 rows at a time with pg_sleep(0.1) between batches
```

---

# PART 5 — ARCHITECTURE DIAGRAMS

## 5.1 System Context

```
                        ┌─────────────────────────────────────┐
                        │           KOWRI PLATFORM            │
                        │                                     │
  Mobile Users ────────►│  /api/*     Express + TypeScript    │
  Merchants ───────────►│                                     │
  Diaspora Users ──────►│  PostgreSQL  │  Event Bus           │
  Tontine Members ─────►│  (primary)   │  (persistent)        │
  Developers ──────────►│                                     │
  USSD Users ──────────►│  Drizzle ORM │  Audit Trail         │
                        └─────────────────────────────────────┘
                                      │
                        ┌─────────────▼───────────────────────┐
                        │         EXTERNAL SYSTEMS             │
                        │                                     │
                        │  Mobile Money APIs  (MTN, Orange)   │
                        │  FX Providers       (ECB, Fixer)    │
                        │  SMS Gateway        (USSD)          │
                        │  Payment Processors (Stripe, etc.)  │
                        │  KYC Provider       (Jumio)         │
                        └─────────────────────────────────────┘
```

## 5.2 Container Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        KOWRI PLATFORM                                │
│                                                                      │
│  ┌───────────────────┐   ┌───────────────────┐                       │
│  │   API SERVER      │   │   DASHBOARD        │                      │
│  │   (Express/TS)    │   │   (React/Vite)     │                      │
│  │   Port: $PORT     │   │   Port: $PORT      │                      │
│  └────────┬──────────┘   └───────────────────┘                      │
│           │                                                          │
│  ┌────────▼──────────────────────────────────────────────────┐      │
│  │                   SERVICE LIBRARIES                        │      │
│  │                                                           │      │
│  │  walletService   │ tontineScheduler  │ savingsEngine      │      │
│  │  reputationEng   │ diasporaService   │ creatorEconomy     │      │
│  │  fraudEngine     │ riskEngine        │ clearingEngine     │      │
│  │  fxLiquidity     │ amlEngine         │ ledgerIntegrity    │      │
│  └────────┬──────────────────────────────────────────────────┘      │
│           │                                                          │
│  ┌────────▼──────────────────────────────────────────────────┐      │
│  │                   DATA LAYER                               │      │
│  │                                                           │      │
│  │  PostgreSQL (Primary)     │  PostgreSQL (Read Replica)    │      │
│  │  - OLTP writes            │  - Transaction history        │      │
│  │  - Ledger entries         │  - Dashboard queries          │      │
│  │  - Event outbox           │  - Fraud analysis reads       │      │
│  │                           │                               │      │
│  │  In-Process Cache         │  Event Outbox Worker          │      │
│  │  - FX rates (5min TTL)    │  - Polls every 500ms          │      │
│  │  - Corridors (24h TTL)    │  - Publishes to EventBus      │      │
│  └───────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

## 5.3 Critical Sequence Diagrams

### Transfer with Idempotency + Locking

```
Client                   API Router           walletService         PostgreSQL
  │                           │                     │                    │
  │  POST /wallets/transfer   │                     │                    │
  │  Idempotency-Key: abc123  │                     │                    │
  │──────────────────────────►│                     │                    │
  │                           │                     │                    │
  │                    [requireIdempotencyKey]       │                    │
  │                    [checkIdempotency: miss]      │                    │
  │                           │                     │                    │
  │                           │  processTransfer()  │                    │
  │                           │────────────────────►│                    │
  │                           │                     │  BEGIN TRANSACTION │
  │                           │                     │───────────────────►│
  │                           │                     │  SELECT FOR UPDATE  │
  │                           │                     │  ORDER BY id       │
  │                           │                     │───────────────────►│
  │                           │                     │  ◄── locked rows   │
  │                           │                     │  CHECK balance     │
  │                           │                     │───────────────────►│
  │                           │                     │  ◄── sufficient    │
  │                           │                     │  INSERT tx record  │
  │                           │                     │───────────────────►│
  │                           │                     │  INSERT ledger ×2  │
  │                           │                     │───────────────────►│
  │                           │                     │  UPDATE wallets ×2 │
  │                           │                     │───────────────────►│
  │                           │                     │  INSERT outbox     │
  │                           │                     │───────────────────►│
  │                           │                     │  COMMIT            │
  │                           │                     │───────────────────►│
  │                           │                     │  ◄── committed     │
  │                           │  [saveIdempotentResponse]                │
  │                           │                     │                    │
  │  ◄── 200 { txId, ... }    │                     │                    │
  │                           │                     │                    │
  │  [RETRY with same key]    │                     │                    │
  │──────────────────────────►│                     │                    │
  │                    [checkIdempotency: HIT]       │                    │
  │  ◄── 200 { txId, ... }    │  ← cached replay   │                    │
  │     X-Idempotent-Replayed: true                  │                    │
```

### Event Outbox Flow

```
Business TX               PostgreSQL            OutboxWorker          EventBus
     │                        │                      │                    │
     │  COMMIT (tx + outbox)  │                      │                    │
     │───────────────────────►│                      │                    │
     │                        │                      │                    │
     │  ◄── committed         │  [every 500ms]       │                    │
                              │◄─────────────────────│                    │
                              │  SELECT pending       │                    │
                              │  FOR UPDATE SKIP LOCKED                   │
                              │──────────────────────►│                   │
                              │  ◄── event rows      │                    │
                              │                      │  publish(type, payload)
                              │                      │───────────────────►│
                              │                      │                    │ emit()
                              │                      │  UPDATE status='published'
                              │                      │───────────────────►│
                              │  ◄── updated         │                    │
```

### Tontine Payout with Locking

```
Admin                    API Router            tontineScheduler     walletService
  │                           │                     │                    │
  │  POST /tontines/:id/payout│                     │                    │
  │──────────────────────────►│                     │                    │
  │                           │  runPayoutCycle()   │                    │
  │                           │────────────────────►│                    │
  │                           │                     │  SELECT tontine    │
  │                           │                     │  + members         │
  │                           │                     │  GET currentRound  │
  │                           │                     │  recipient = members[round % n]
  │                           │                     │                    │
  │                           │                     │  processTransfer(  │
  │                           │                     │    from: tontine.walletId
  │                           │                     │    to: recipient.walletId
  │                           │                     │  )                 │
  │                           │                     │───────────────────►│
  │                           │                     │                    │ [SELECT FOR UPDATE]
  │                           │                     │                    │ [balance check]
  │                           │                     │                    │ [ledger entries]
  │                           │                     │                    │ [COMMIT]
  │                           │                     │◄───────────────────│
  │                           │                     │  UPDATE tontine    │
  │                           │                     │  currentRound++    │
  │  ◄── 200 { round, ... }   │◄────────────────────│                    │
```

### Fraud Check Flow

```
Client              processTransfer()         riskEngine (PRE)      fraudEngine (POST)
  │                       │                        │                      │
  │  Transfer request     │                        │                      │
  │──────────────────────►│                        │                      │
  │                       │  evaluateRisk()         │                      │
  │                       │───────────────────────►│                      │
  │                       │                        │ velocity check        │
  │                       │                        │ amount anomaly        │
  │                       │                        │ account age           │
  │                       │                        │ counterparty score    │
  │                       │◄───────────────────────│                      │
  │                       │  { score: 30, action: "allow" }               │
  │                       │                        │                      │
  │                       │  [BEGIN TRANSACTION]   │                      │
  │                       │  [ledger write]        │                      │
  │                       │  [COMMIT]              │                      │
  │                       │                        │                      │
  │                       │  setImmediate ─────────────────────────────►  │
  │  ◄── 200              │                        │  runFraudCheck()     │
                                                   │  (async, non-blocking│
                                                   │   creates AML case   │
                                                   │   if score > 70)     │
```

---

# PART 6 — CRITICAL PSEUDOCODE

## 6.1 SafeWalletMutationService

```typescript
// lib/safeWalletMutation.ts

export async function safeWalletDebit(params: {
  walletId: string;
  amount: number;
  currency: string;
  reason: string;
  entityType: string;  // 'savings_plan' | 'tontine' | 'insurance'
  entityId: string;
}): Promise<{ ledgerEntries: string[]; newBalance: number }> {
  return withDeadlockRetry(() =>
    db.transaction(async (tx) => {
      // STEP 1: Acquire exclusive lock
      const [wallet] = await tx.execute(sql`
        SELECT id, currency FROM wallets
        WHERE id = ${params.walletId} FOR UPDATE
      `);
      if (!wallet) throw new Error(`Wallet ${params.walletId} not found`);

      // STEP 2: Check balance from ledger (not stored column)
      const [bal] = await tx.select({
        balance: sql<number>`
          COALESCE(SUM(CAST(credit_amount AS NUMERIC)), 0) -
          COALESCE(SUM(CAST(debit_amount AS NUMERIC)), 0)
        `
      }).from(ledgerEntriesTable)
        .where(sql`account_id = ${params.walletId} AND account_type = 'wallet'`);

      const available = Number(bal.balance ?? 0);
      if (available < params.amount) {
        throw new Error(`Insufficient funds: ${available} < ${params.amount}`);
      }

      // STEP 3: Write double-entry ledger
      const txId  = generateId();
      const debitId  = generateId();
      const creditId = generateId();

      await tx.insert(ledgerEntriesTable).values([
        {
          id: debitId, transactionId: txId,
          accountId: params.walletId, accountType: "wallet",
          debitAmount: String(params.amount), creditAmount: "0",
          currency: params.currency, eventType: params.reason,
          entryType: "debit", walletId: params.walletId,
        },
        {
          id: creditId, transactionId: txId,
          accountId: params.entityId, accountType: params.entityType,
          debitAmount: "0", creditAmount: String(params.amount),
          currency: params.currency, eventType: params.reason,
          entryType: "credit", walletId: null,
        },
      ]);

      // STEP 4: Sync stored balance
      const newBalance = await syncWalletBalance(params.walletId, tx as any);

      // STEP 5: Write outbox (atomic with above)
      await tx.insert(eventOutboxTable).values({
        id: generateId(),
        aggregateType: params.entityType,
        aggregateId: params.entityId,
        eventType: `${params.entityType}.funded`,
        payload: {
          walletId: params.walletId,
          amount: params.amount,
          currency: params.currency,
          newBalance,
          entityId: params.entityId,
        },
      });

      return { ledgerEntries: [debitId, creditId], newBalance };
    })
  );
}
```

## 6.2 Idempotency Middleware (Enhanced)

```typescript
// middleware/idempotency.ts — enhanced version

export function fullIdempotencyGuard(
  req: Request, res: Response, next: NextFunction
): void {
  const key = (req.headers["idempotency-key"] as string)?.trim();

  if (!key) {
    res.status(400).json({
      error: true, code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "Idempotency-Key header is required for all financial operations",
    });
    return;
  }

  const endpoint = `${req.method}:${req.path}`;
  const requestHash = hashPayload(req.body);

  db.select().from(idempotencyKeysTable)
    .where(and(
      eq(idempotencyKeysTable.key, key),
      eq(idempotencyKeysTable.endpoint, endpoint)
    ))
    .limit(1)
    .then(async ([existing]) => {
      if (existing) {
        // Verify payload hasn't changed (different payload = different request)
        if (existing.requestHash && existing.requestHash !== requestHash) {
          res.status(422).json({
            error: true, code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
            message: "Idempotency key reused with different request payload",
          });
          return;
        }

        res.setHeader("X-Idempotent-Replayed", "true");
        res.status(existing.statusCode ?? 200).json(existing.responseBody);
        return;
      }

      req.saveIdempotentResponse = async (body: unknown, statusCode = 200) => {
        await db.insert(idempotencyKeysTable).values({
          id: generateId(),
          key, endpoint, requestHash,
          statusCode,
          responseBody: body as any,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }).onConflictDoNothing();
      };

      next();
    })
    .catch(next);
}
```

## 6.3 Reconciliation Service

```typescript
// lib/ledgerIntegrity.ts

export async function runLedgerReconciliation(
  scope: "high_activity" | "all" = "high_activity"
): Promise<IntegrityReport> {
  const startedAt = Date.now();
  const reportId  = generateId();

  let wallets: WalletRow[];
  if (scope === "high_activity") {
    // Only wallets with transactions in last 60 minutes
    wallets = await db.execute(sql`
      SELECT DISTINCT w.* FROM wallets w
      INNER JOIN transactions t ON (t.from_wallet_id = w.id OR t.to_wallet_id = w.id)
      WHERE t.created_at > NOW() - INTERVAL '1 hour'
    `);
  } else {
    wallets = await db.select().from(walletsTable);
  }

  let discrepanciesFound = 0;
  let correctionsMade    = 0;
  let totalDelta         = 0;

  for (const wallet of wallets) {
    const derived = await getWalletBalance(wallet.id);
    const stored  = Number(wallet.balance);
    const delta   = Math.abs(stored - derived);

    if (delta > 0.0001) {
      discrepanciesFound++;
      totalDelta += delta;

      // AUTO-CORRECT
      await syncWalletBalance(wallet.id);
      correctionsMade++;

      await audit({
        action: "reconciliation.fixed",
        entity: "wallet", entityId: wallet.id,
        metadata: { stored, derived, delta, correctedAt: new Date() },
      });

      if (delta > 100) {
        await triggerAlert("P0", "LEDGER_DISCREPANCY", {
          walletId: wallet.id, stored, derived, delta
        });
      } else {
        await triggerAlert("P1", "LEDGER_DISCREPANCY_MINOR", {
          walletId: wallet.id, stored, derived, delta
        });
      }
    }
  }

  const report = {
    id: reportId, scope,
    walletsChecked:   wallets.length,
    discrepanciesFound,
    correctionsMade,
    totalDelta,
    durationMs: Date.now() - startedAt,
  };

  await db.insert(integrityReportsTable).values(report);
  return report;
}
```

## 6.4 Risk Scoring Engine

```typescript
// lib/riskEngine.ts

export async function scoreTransaction(params: TransactionRiskParams): Promise<RiskDecision> {
  const factors: RiskFactor[] = [];
  let score = 0;

  // Factor 1 — Transaction velocity (last 60 minutes)
  const recentTxns = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM transactions
    WHERE from_wallet_id = ${params.fromWalletId}
      AND created_at > NOW() - INTERVAL '1 hour'
      AND status = 'completed'
  `);
  if (Number(recentTxns.rows[0]?.count) > 10) {
    score += 30;
    factors.push({ name: "HIGH_VELOCITY", weight: 30 });
  }

  // Factor 2 — Amount anomaly vs. 90-day average
  const avgResult = await db.execute<{ avg: number }>(sql`
    SELECT AVG(CAST(amount AS NUMERIC)) AS avg FROM transactions
    WHERE from_wallet_id = ${params.fromWalletId}
      AND created_at > NOW() - INTERVAL '90 days'
      AND status = 'completed'
  `);
  const avg = Number(avgResult.rows[0]?.avg ?? 0);
  if (avg > 0 && params.amount > avg * 5) {
    score += 25;
    factors.push({ name: "AMOUNT_ANOMALY", weight: 25, detail: `${params.amount} > ${avg * 5}` });
  }

  // Factor 3 — Account age
  const walletResult = await db.select().from(walletsTable)
    .where(eq(walletsTable.id, params.fromWalletId)).limit(1);
  const ageMs  = Date.now() - new Date(walletResult[0]?.createdAt ?? 0).getTime();
  const ageDays = ageMs / 86400000;
  if (ageDays < 7) {
    score += 20;
    factors.push({ name: "NEW_ACCOUNT", weight: 20, detail: `age=${Math.floor(ageDays)}d` });
  }

  // Factor 4 — Counterparty risk (has AML case open?)
  const amlResult = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM aml_cases
    WHERE wallet_id = ${params.toWalletId} AND status = 'open'
  `);
  if (Number(amlResult.rows[0]?.count) > 0) {
    score += 15;
    factors.push({ name: "RISKY_COUNTERPARTY", weight: 15 });
  }

  // Factor 5 — Large amount threshold (>= 1M XOF)
  if (params.amount >= 1_000_000) {
    score += 10;
    factors.push({ name: "LARGE_AMOUNT", weight: 10 });
  }

  const action: "allow" | "review" | "block" =
    score >= 80 ? "block" :
    score >= 50 ? "review" :
    "allow";

  // Persist risk score
  await db.insert(riskScoresTable).values({
    id: generateId(),
    walletId: params.fromWalletId,
    score, action,
    reasons: factors.map(f => f.name),
    amount: String(params.amount),
    currency: params.currency,
  });

  return { score, action, factors };
}
```

---

# PART 7 — ERROR HANDLING CONVENTIONS

## 7.1 Error Types and HTTP Status Mapping

```typescript
// Standard error taxonomy for all routes

// 400 Bad Request — Client sent invalid data
{ error: true, code: "VALIDATION_ERROR",       message: "amount must be positive" }
{ error: true, code: "MISSING_FIELD",          message: "walletId is required" }
{ error: true, code: "IDEMPOTENCY_KEY_REQUIRED", message: "..." }
{ error: true, code: "INVALID_CURRENCY",       message: "XYZ is not supported" }

// 402 Payment Required — Insufficient funds
{ error: true, code: "INSUFFICIENT_FUNDS",     message: "Available: 500, Required: 1000" }

// 403 Forbidden — Risk block
{ error: true, code: "TRANSACTION_BLOCKED",    message: "Transaction flagged by risk engine", riskScore: 82 }

// 404 Not Found
{ error: true, code: "NOT_FOUND",              message: "Wallet abc123 not found" }

// 409 Conflict — Duplicate resource
{ error: true, code: "DUPLICATE_PHONE",        message: "Phone already registered" }
{ error: true, code: "DUPLICATE_MEMBER",       message: "User is already a tontine member" }
{ error: true, code: "DUPLICATE_HANDLE",       message: "Community handle taken" }

// 422 Unprocessable — Semantic error
{ error: true, code: "IDEMPOTENCY_MISMATCH",   message: "Key reused with different payload" }
{ error: true, code: "INVALID_STATE",          message: "Tontine is not in pending state" }

// 429 Too Many Requests — Rate limit
{ error: true, code: "RATE_LIMIT_EXCEEDED",    message: "Max 10 transactions/hour", retryAfter: 3600 }

// 500 Internal Server Error
{ error: true, code: "INTERNAL_ERROR",         message: "An unexpected error occurred", requestId: "uuid" }
```

## 7.2 Retry Strategy by Error Type

```
Error Type                HTTP Status    Client Should Retry?    Backoff
─────────────────────────────────────────────────────────────────────────
INSUFFICIENT_FUNDS        402            No                      —
TRANSACTION_BLOCKED       403            No                      —
NOT_FOUND                 404            No                      —
DUPLICATE_*               409            No                      —
IDEMPOTENCY_MISMATCH      422            No                      —
RATE_LIMIT_EXCEEDED       429            Yes (after retryAfter)  Fixed
INTERNAL_ERROR            500            Yes (with idempotency)  Exponential
Network timeout           —              Yes (with idempotency)  Exponential
```

## 7.3 Dead Letter Handling

Events that fail after 5 retries in the outbox worker are moved to `status = 'dead_letter'`. An admin endpoint exposes dead letter events for manual reprocessing:

```
GET  /api/admin/dead-letter?aggregate_type=wallet
POST /api/admin/dead-letter/:id/retry    — requeue single event
POST /api/admin/dead-letter/retry-all   — requeue all dead letters
```

---

# PART 8 — SCALABILITY STRATEGIES

## 8.1 Database Scaling

```
Phase    Users     Strategy
────────────────────────────────────────────────────────────────
Now      100K      Single primary + 1 read replica (already have multi-region)
Phase 8  1M        Connection pooling (PgBouncer), read replica for history queries
Phase 9  5M        Table partitioning (ledger_entries by month), materialised views
Phase 10 10M       Horizontal read replicas per region, analytics DB separation
```

**Connection pool configuration:**

```
Primary (writes):   max_connections = 200 → PgBouncer pool_size = 20 per app instance
Read replica:       max_connections = 200 → PgBouncer pool_size = 50 (read-heavy)
Analytics DB:       max_connections = 20 → long-running queries isolated
```

**Indexing strategy:**

```sql
-- Critical indexes already required
CREATE INDEX CONCURRENTLY idx_tx_from_wallet_time
  ON transactions(from_wallet_id, created_at DESC);

CREATE INDEX CONCURRENTLY idx_tx_to_wallet_time
  ON transactions(to_wallet_id, created_at DESC);

CREATE INDEX CONCURRENTLY idx_ledger_account_time
  ON ledger_entries(account_id, created_at DESC);

CREATE INDEX CONCURRENTLY idx_ledger_tx_id
  ON ledger_entries(transaction_id);

-- Partial indexes for common filtered queries
CREATE INDEX CONCURRENTLY idx_loans_active
  ON loans(user_id, status) WHERE status IN ('active', 'overdue');

CREATE INDEX CONCURRENTLY idx_tontines_active
  ON tontines(status, next_payout_date) WHERE status = 'active';

CREATE INDEX CONCURRENTLY idx_savings_active
  ON savings_plans(user_id, maturity_date) WHERE status = 'active';
```

## 8.2 Horizontal Scaling

KOWRI's stateless API server can scale horizontally immediately. The only state is in PostgreSQL.

```
Load Balancer (round-robin)
       │
  ┌────┴────────────────────────┐
  │         │          │        │
  ▼         ▼          ▼        ▼
API-1     API-2      API-3    API-4
  │         │          │        │
  └────┬────────────────────────┘
       │
  PgBouncer (connection pooler)
       │
  PostgreSQL Primary
       │
  PostgreSQL Read Replica(s)
```

For the outbox worker: ensure only ONE instance processes outbox at a time. Use `SELECT ... FOR UPDATE SKIP LOCKED` (already in the pseudocode above) — this correctly handles multiple instances without duplicate event delivery.

## 8.3 Sharding Strategy (10M+ scale)

If single-DB throughput becomes the bottleneck (typically at >50,000 TPS), shard by `user_id` prefix:

```
Shard 0 (users 00-1F): Wallets, transactions, ledger entries for these users
Shard 1 (users 20-3F): ...
...
Shard 15 (users E0-FF): ...

Routing: SHA256(wallet_id)[0] → shard index
```

This is NOT needed until 2M+ TPS. Implement CQRS first — it typically provides 10× more headroom than sharding for read-heavy workloads.

---

# PART 9 — AFRICAN INFRASTRUCTURE CONSIDERATIONS

## 9.1 Offline Queue (Intermittent Connectivity)

Mobile users on 2G/3G networks experience frequent disconnections. The platform must accept queued operations that execute when connectivity resumes:

```
Client (offline)        → Local queue (device storage)
Client (reconnects)     → POST /api/offline/queue/sync
API                     → Process queued operations in order
API                     → Return results with per-operation status
```

**Endpoint:**

```
POST /api/offline/queue/sync
Body: {
  userId: string,
  operations: Array<{
    tempId: string,          // client-generated correlation ID
    type: "transfer" | "tontine_bid" | "tontine_contribution",
    payload: object,
    idempotencyKey: string,  // client must generate offline
    queuedAt: ISO8601
  }>
}
Response: {
  results: Array<{
    tempId: string,
    success: boolean,
    data?: object,
    error?: string
  }>
}
```

## 9.2 USSD Interface

For feature phones and users without data plans, USSD provides access to core financial operations:

```
*384*1# → KOWRI MAIN MENU

1. Check Balance
2. Send Money
3. Tontine
4. Savings
5. My Account

Flow for "Send Money":
KOWRI> Enter recipient phone: [user input]
KOWRI> Enter amount in XOF: [user input]
KOWRI> Send 5000 XOF to +233-XX? 1=Yes 2=No
KOWRI> ✓ Sent. New balance: 45,000 XOF. Ref: KWR-XX
```

**API endpoint:**

```
POST /api/ussd/callback
Body: { sessionId, phoneNumber, text, serviceCode }
→ Maintains session state in ussd_sessions table
→ Returns USSD response string within 3 seconds
```

## 9.3 Low-Bandwidth Optimisation

```typescript
// Minimal response mode for 2G connections
// Activated by: Accept-Encoding: minimal or X-Kowri-Bandwidth: low

// Standard response:
{ id, amount, currency, status, createdAt, fromWallet, toWallet, reference, ... }

// Minimal response (saves ~70% bandwidth):
{ id, amt, cur, ok: true }
```

---

# PART 10 — IMPLEMENTATION ROADMAP

## Phase 8 — Critical Hardening (Weeks 1–2)

**Objective:** Remove all structural flaws before scaling.

| Task | File | Priority |
|---|---|---|
| Apply idempotency middleware to transfer, collect, payout, repay | `routes/*.ts` | P0 |
| Add expires_at TTL to idempotency_keys | `schema.ts` | P0 |
| Create idempotency cleanup job | `src/index.ts` | P0 |
| Add event_outbox table + schema | `schema.ts` | P0 |
| Implement outbox worker | `lib/outboxWorker.ts` | P0 |
| Integrate outbox writes into processTransfer/Deposit | `lib/walletService.ts` | P0 |
| Schedule ledger reconciliation (hourly/daily) | `src/index.ts` | P1 |
| Add DB constraints to wallets + ledger_entries | Migration | P1 |
| Extend AuditAction type to cover all events | `lib/auditLogger.ts` | P1 |
| Add before_state/after_state to audit_logs | `schema.ts` | P1 |
| Implement withDeadlockRetry() | `lib/walletService.ts` | P1 |

**Success criteria:** Zero event loss on network partition simulation. Zero double-charges on retry storm test.

## Phase 9 — Risk Engine (Weeks 3–4)

**Objective:** Pre-payment risk gate for all financial flows.

| Task | File | Priority |
|---|---|---|
| Implement scoreTransaction() | `lib/riskEngine.ts` | P0 |
| Create risk_scores table | `schema.ts` | P0 |
| Integrate pre-payment risk gate into processTransfer | `lib/walletService.ts` | P0 |
| Implement triggerAlert() | `lib/alertManager.ts` | P0 |
| Create alert_log table | `schema.ts` | P0 |
| Add risk score endpoint | `routes/risk.ts` | P1 |
| Admin: GET /admin/alerts (unresolved P0/P1) | `routes/admin.ts` | P1 |
| Risk threshold configuration (not hard-coded) | `lib/riskEngine.ts` | P2 |

**Success criteria:** Blocks 95%+ of simulated fraud scenarios. False positive rate < 2%.

## Phase 10 — Read Separation (Weeks 5–6)

**Objective:** Protect transactional DB from analytical workloads.

| Task | File | Priority |
|---|---|---|
| Configure read replica connection in Drizzle | `db/index.ts` | P0 |
| Route history queries to read replica | `routes/transactions.ts` | P0 |
| Route analytics queries to read replica | `routes/analytics.ts` | P0 |
| Create wallet_summary materialised view | Migration | P1 |
| Implement cache layer for FX rates | `lib/fxEngine.ts` | P1 |
| Implement cache layer for corridors | `lib/diasporaService.ts` | P1 |
| Add monthly partitions for ledger_entries | Migration | P2 |
| Implement GET /api/admin/integrity/check | `routes/admin.ts` | P2 |

**Success criteria:** P95 transfer latency < 100ms. Dashboard queries don't affect payment latency.

## Phase 11 — African Reach (Weeks 7–8)

**Objective:** Reliable service for all African users, regardless of connectivity.

| Task | File | Priority |
|---|---|---|
| Implement offline_queue table + sync endpoint | `schema.ts`, `routes/*.ts` | P0 |
| Implement USSD callback endpoint | `routes/ussd.ts` | P0 |
| USSD session state management | `lib/ussdEngine.ts` | P0 |
| Low-bandwidth response mode | `middleware/bandwidth.ts` | P1 |
| Mobile money provider connectors (MTN, Orange) | `lib/mobileMoneyProvider.ts` | P1 |
| Agent network endpoint (cash-in/cash-out) | `routes/agent.ts` | P2 |

**Success criteria:** Full tontine cycle completable over USSD. Offline operations sync correctly on reconnect.

## Phase 12 — Observability (Weeks 9–10)

**Objective:** Production-grade visibility into all system behaviour.

| Task | File | Priority |
|---|---|---|
| Structured alert taxonomy (P0/P1/P2) | `lib/alertManager.ts` | P0 |
| Prometheus-compatible metrics endpoint | `routes/system.ts` | P1 |
| Distributed trace ID propagation | `middleware/tracing.ts` | P1 |
| Outbox queue depth monitoring | `lib/outboxWorker.ts` | P1 |
| Fraud alert burst detection | `lib/riskEngine.ts` | P1 |
| Dead letter admin endpoints | `routes/admin.ts` | P2 |
| Reconciliation report endpoint | `routes/admin.ts` | P2 |

**Success criteria:** P0 alert fires within 30 seconds of ledger discrepancy. Dashboard loads in < 1s with 10M wallet records.

---

# PART 11 — OPERATIONAL CONSIDERATIONS

## 11.1 Backup and Recovery

```
PostgreSQL Backup Strategy:
  WAL archiving:          Continuous (every 5 minutes to object storage)
  Daily base backup:      Full snapshot at 03:00 UTC
  Point-in-time recovery: Up to the second for the last 30 days
  Geo-redundant copies:   Primary region + 1 remote region

RTO / RPO Targets:
  Critical (payments):    RTO < 2min,   RPO < 30sec
  Standard:               RTO < 15min,  RPO < 5min

Recovery Drill:
  Monthly: Restore from WAL to staging, run full test suite
  Verify:  Ledger integrity check on restored database
```

## 11.2 Incident Response

```
P0 — CRITICAL (payment system down, ledger discrepancy)
  1. Auto-alert fires (< 30 seconds)
  2. On-call engineer acknowledges (SLA: 5 minutes)
  3. Declare incident, post status page update
  4. Enable read-only mode if data integrity at risk
  5. Rollback to last known good checkpoint
  6. Run reconciliation on restored database
  7. Resume service, monitor for 30 minutes
  8. Post-mortem within 48 hours

P1 — WARNING (degraded, high latency, queue backlog)
  1. Alert fires
  2. On-call reviews (SLA: 30 minutes)
  3. Scale horizontally if load-related
  4. Drain and replay outbox if queue-related
```

## 11.3 Capacity Planning

```
Metric                  Now      Phase 8   Phase 10
──────────────────────────────────────────────────────
Active wallets          300K     3M        30M
Transactions/day        50K      2M        20M
Ledger entries/day      100K     4M        40M
Audit logs/day          200K     8M        80M
DB storage growth       5GB/mo   200GB/mo  2TB/mo
API requests/sec        200      5K        50K
```

At Phase 8 scale (3M wallets, 2M tx/day), the critical investments are:
1. Connection pooling (PgBouncer) — prevents DB connection exhaustion
2. Read replica for history — protects write path
3. Ledger partitioning — keeps query times bounded as data grows

---

# PART 12 — SECURITY CONSIDERATIONS

## 12.1 Authentication and Authorization

```
Current:  PIN-based authentication (hashed at rest)
Phase 8:  JWT tokens with short expiry (15min access, 30d refresh)
Phase 9:  MFA for transactions above risk threshold
Phase 10: Biometric support for mobile (platform API delegation)
```

**API authorization matrix:**

```
Endpoint Category        User    Merchant    Admin   API Key
─────────────────────────────────────────────────────────────
Own wallet read          ✓       ✓           ✓       ✓
Own wallet transfer      ✓       ✓           ✗       ✓
Other user's data        ✗       ✗           ✓       ✗
Platform analytics       ✗       ✗           ✓       ✗
Admin reconciliation     ✗       ✗           ✓       ✗
Tontine management       ✓       ✗           ✓       ✓
```

## 12.2 Data Encryption

```
At Rest:
  - PIN/password: bcrypt (cost factor 12)
  - Sensitive PII (national ID, bank account): AES-256-GCM, keys in HSM
  - Database: TDE via PostgreSQL pgcrypto or cloud provider encryption

In Transit:
  - All endpoints: TLS 1.3 minimum
  - Inter-service: mTLS for admin/internal endpoints
  - Webhook delivery: HMAC-SHA256 signature on payload

Key Management:
  - Application secrets: Environment variables (never in code)
  - Encryption keys: Separate key service, rotated quarterly
  - API keys: SHA-256 hashed before storage (same pattern as passwords)
```

## 12.3 Compliance

```
Africa-specific:
  BCEAO (West Africa):   AML/KYC requirements, transaction reporting
  CBN (Nigeria):         BVN verification, daily transfer limits
  BOG (Ghana):           Mobile money interoperability
  CBK (Kenya):           Safaricom M-PESA integration requirements

Global:
  GDPR (diaspora users): Right to erasure, data portability
  FATF:                  AML risk categories, suspicious transaction reporting
```

---

# PART 13 — STRESS TEST REQUIREMENTS

## 13.1 Test Scenarios and Success Criteria

```
Test 1 — Concurrent Transfer Flood
  Scenario:  100 concurrent transfers from same wallet simultaneously
  Method:    bombardier -c 100 -n 100 POST /api/wallets/transfer
  Expected:  Exactly 1 succeeds (if amount = full balance)
             All others: 402 Insufficient Funds
             No negative balances, ledger balanced

Test 2 — Retry Storm (Idempotency)
  Scenario:  100 identical requests with same Idempotency-Key within 1 second
  Method:    Parallel fetch() with same key
  Expected:  Exactly 1 financial operation executes
             All 100 responses are identical
             Audit log shows 1 transaction, 99 replays

Test 3 — Outbox Reliability
  Scenario:  Kill event bus mid-transaction, restart
  Method:    SIGKILL after ledger write, before event publish
  Expected:  Outbox worker replays event on restart
             No duplicate financial effects
             Event eventually published (at-least-once)

Test 4 — Tontine Payout Race
  Scenario:  10 concurrent POST /tontines/:id/payout requests
  Method:    Parallel fetch()
  Expected:  Exactly 1 payout executes (others: 400 or 409)
             Recipient receives exactly 1 payout
             Pool wallet not overdrafted

Test 5 — Sustained Load
  Scenario:  5,000 TPS for 10 minutes (peak load simulation)
  Tools:     k6 with staged ramp: 0→5K TPS over 2 minutes, hold 8 minutes
  Targets:
    P95 latency < 200ms
    P99 latency < 800ms
    Error rate  < 0.5%
    0 ledger discrepancies after load

Test 6 — Offline Queue Sync
  Scenario:  500 users queue operations offline, sync simultaneously
  Expected:  All operations processed in correct order
             Duplicate keys rejected (idempotency)
             Zero lost operations
```

## 13.2 Performance Baselines (Current)

```
Endpoint                    P50     P95     P99     Error%
────────────────────────────────────────────────────────────
POST /api/wallets/transfer  45ms    120ms   350ms   0.2%
POST /api/wallets/deposit   35ms    95ms    280ms   0.1%
GET  /api/wallets/:id       8ms     22ms    65ms    0.0%
POST /api/tontines/collect  85ms    220ms   580ms   0.3%
GET  /api/analytics/overview 120ms  450ms   1200ms  0.0%
```

## 13.3 Target Baselines (Phase 10, 3M users)

```
Endpoint                    P50     P95     P99     Error%
────────────────────────────────────────────────────────────
POST /api/wallets/transfer  40ms    150ms   400ms   0.1%
POST /api/wallets/deposit   30ms    100ms   300ms   0.1%
GET  /api/wallets/:id       5ms     15ms    40ms    0.0%
POST /api/tontines/collect  70ms    180ms   450ms   0.2%
GET  /api/analytics/overview 30ms   80ms    200ms   0.0%
                                                   ↑
                             Analytics now reads from replica/materialised view
```

---

# APPENDIX A — Complete Table Inventory (44 tables)

| # | Table | Domain | Phase |
|---|---|---|---|
| 1 | users | Identity | 1 |
| 2 | wallets | Payments | 1 |
| 3 | transactions | Ledger | 1 |
| 4 | ledger_entries | Ledger | 1 |
| 5 | idempotency_keys | Reliability | 1 |
| 6 | audit_logs | Compliance | 1 |
| 7 | event_log | Events | 1 |
| 8 | tontines | Community | 3 |
| 9 | tontine_members | Community | 3 |
| 10 | loans | Credit | 3 |
| 11 | kyc_documents | Compliance | 3 |
| 12 | credit_scores | Credit | 4 |
| 13 | fx_rates | FX | 4 |
| 14 | aml_cases | Compliance | 4 |
| 15 | merchant_profiles | Merchant | 2 |
| 16 | payment_links | Merchant | 2 |
| 17 | webhooks | Developer | 2 |
| 18 | settlements | Settlement | 3 |
| 19 | message_queue | Infra | 4 |
| 20 | sagas | Infra | 3 |
| 21 | fraud_alerts | Security | 3 |
| 22 | fraud_rules | Security | 3 |
| 23 | clearing_batches | Settlement | 5 |
| 24 | liquidity_pools | FX | 5 |
| 25 | processor_routes | Routing | 5 |
| 26 | regulatory_reports | Compliance | 5 |
| 27 | report_entries | Compliance | 5 |
| 28 | regions | Infra | 5 |
| 29 | tontine_bids | Community | 7 |
| 30 | tontine_position_listings | Community | 7 |
| 31 | reputation_scores | Community | 7 |
| 32 | savings_plans | Savings | 7 |
| 33 | investment_pools | Investment | 7 |
| 34 | pool_positions | Investment | 7 |
| 35 | insurance_pools | Insurance | 7 |
| 36 | insurance_policies | Insurance | 7 |
| 37 | insurance_claims | Insurance | 7 |
| 38 | remittance_corridors | Diaspora | 7 |
| 39 | beneficiaries | Diaspora | 7 |
| 40 | recurring_transfers | Diaspora | 7 |
| 41 | creator_communities | Creator | 7 |
| 42 | loan_repayments | Credit | 7 |
| 43 | scheduler_jobs | Infra | 7 |
| 44 | developer_api_keys | Developer | 6 |
| — | event_outbox | Reliability | Phase 8 |
| — | risk_scores | Security | Phase 9 |
| — | integrity_reports | Compliance | Phase 8 |
| — | offline_queue | Connectivity | Phase 11 |
| — | ussd_sessions | Connectivity | Phase 11 |
| — | alert_log | Operations | Phase 9 |

---

# APPENDIX B — Service Dependency Graph

```
                         ┌─────────────┐
                         │  eventBus   │
                         └──────┬──────┘
                                │ consumes
         ┌──────────────────────┼──────────────────────┐
         │                      │                      │
         ▼                      ▼                      ▼
   webhookDispatcher     analyticsEngine        notificationSvc
   (external push)       (read replica)         (SMS/push)

                         ┌─────────────┐
                         │ walletService│◄──── ALL financial ops
                         └──────┬──────┘
                                │
              ┌─────────────────┼─────────────────────┐
              ▼                 ▼                     ▼
       ledgerEntries      transactionsTable      eventOutbox
       (double entry)     (immutable record)    (at-least-once)

walletService dependencies:
  → ledger (read/write)
  → auditLogger (write)
  → eventBus (publish)
  → stateMachine (validate transitions)
  → rateLimiter (pre-check)
  → riskEngine (pre-check)
  → fraudEngine (post-check)
  → metrics (record)

Service consumers of walletService:
  tontineScheduler    → processTransfer (contributions + payouts)
  savingsEngine       → processDeposit / processTransfer (lock/unlock)
  investmentPools     → processTransfer (invest / distribute)
  insurancePools      → processTransfer (premium / payout)
  diasporaService     → processTransfer (remittance)
  creditEngine        → processDeposit (loan disbursement)
  creatorEconomy      → processTransfer (fee distribution)
```

---

*KOWRI V5.0 — Continental Scale Architecture*  
*Phase 7 complete: 151/151 tests. Phase 8–12 roadmap ready for implementation.*  
*"THE FINANCIAL INFRASTRUCTURE OF AFRICAN COMMUNITIES."*
