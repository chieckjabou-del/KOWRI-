# KOWRI V5.0 - Digital Financial Infrastructure

## Overview

KOWRI is a production-grade fintech backend platform for African markets, built as a pnpm workspace monorepo using TypeScript. Features wallets, tontines (group savings), micro-credit, merchant payments, KYC/compliance, and a financial reputation scoring engine.

**Current Phase: Phase 2 — Production-Grade Architecture**

## Phase 2 Architecture (Active)

All components implemented and validated (61/61 tests passing):

| Component | Implementation |
|-----------|---------------|
| Immutable Ledger | PostgreSQL triggers block UPDATE/DELETE on `ledger_entries` — append-only forever |
| Idempotency System | `Idempotency-Key` header required on all POST financial ops; cached responses in `idempotency_keys` table |
| Event-Driven Flow | Node EventEmitter bus publishes `transaction.created`, `wallet.balance.updated`, `loan.disbursed`, etc. |
| Transaction State Machine | Strict lifecycle: pending → processing → completed (or failed); completed → reversed |
| Concurrency Protection | `SELECT ... FOR UPDATE` locks wallet rows within DB transactions — prevents double-spend |
| Event Log | All emitted events persisted to `event_log` table for audit trail |
| Audit Trail | All financial operations logged to `audit_logs` with action, entity, actor, metadata |
| Performance Indexes | idx on `ledger_entries(account_id)`, `ledger_entries(transaction_id)`, `transactions(reference)`, `wallets(user_id)` |
| Observability | `GET /api/system/metrics` — latency (avg/p95/p99), event counts, memory, uptime |

## API Endpoints

### Core Financial
- `GET/POST /api/wallets` — wallet management
- `POST /api/wallets/:id/deposit` — deposit (requires `Idempotency-Key` header)
- `POST /api/wallets/:id/transfer` — transfer (requires `Idempotency-Key` header, SELECT FOR UPDATE)
- `GET /api/transactions` — transaction history

### Group Savings
- `GET/POST /api/tontines` — tontine management
- `GET /api/tontines/:id` — tontine detail with members

### Micro-Credit
- `GET /api/credit/scores` — credit scoring
- `GET/POST /api/credit/loans` — loan management

### Merchants & Compliance
- `GET /api/merchants` — merchant registry
- `GET /api/compliance/kyc` — KYC records

### Analytics & Admin
- `GET /api/analytics/overview` — platform metrics
- `GET /api/analytics/ledger` — ledger entries (totalDebits always == totalCredits)
- `GET /api/admin/reconcile?fix=true` — wallet balance reconciliation

### Phase 2 System Endpoints (new)
- `GET /api/system/metrics` — latency, events, ledger writes, state machine diagram
- `GET /api/system/events` — event log (paginated)
- `GET /api/system/audit` — audit trail (paginated)

## Database Schema

### Phase 1 Tables
- `users` — customer profiles
- `wallets` — balances derived from ledger
- `transactions` — status: pending|processing|completed|failed|reversed
- `ledger_entries` — double-entry accounting; immutable via triggers; `entry_type` column (debit|credit)
- `tontines` / `tontine_members` — group savings
- `loans` / `credit_scores` — micro-credit
- `merchants` / `kyc_records` — merchant + compliance

### Phase 2 Tables (new)
- `idempotency_keys` — deduplication store keyed by (key, endpoint)
- `event_log` — persisted event bus events
- `audit_logs` — complete audit trail for all financial operations

## Architecture

Full-stack fintech platform with:
- Express.js REST API backend with double-entry ledger accounting
- PostgreSQL with Drizzle ORM for transactional data integrity
- React + Vite dashboard for platform monitoring
- Event-sourced ledger (debits always equal credits)
- Auto-seeded sample data (20 users, 24 wallets, 60+ transactions)

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server (Phase 2)
│   │   └── src/
│   │       ├── lib/
│   │       │   ├── walletService.ts   # processDeposit/processTransfer (FOR UPDATE)
│   │       │   ├── eventBus.ts        # Node EventEmitter + event_log persistence
│   │       │   ├── stateMachine.ts    # Transaction lifecycle state machine
│   │       │   ├── auditLogger.ts     # audit() + getAuditTrail()
│   │       │   └── metrics.ts         # Ring-buffer latency tracking
│   │       ├── middleware/
│   │       │   ├── idempotency.ts     # requireIdempotencyKey + checkIdempotency
│   │       │   ├── validate.ts        # XSS/SQLi guard + enum whitelists
│   │       │   └── errorHandler.ts    # Centralized error handler
│   │       └── routes/
│   │           ├── system.ts          # /api/system/metrics|events|audit
│   │           └── ...                # All other routes (Phase 1 + 2)
│   └── kowri-dashboard/    # React + Vite monitoring dashboard
├── lib/
│   └── db/
│       └── src/schema/
│           ├── phase2.ts   # idempotency_keys, event_log, audit_logs tables
│           └── ...         # Phase 1 tables
└── pnpm-workspace.yaml
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Key Constraints

- All POST financial operations MUST include `Idempotency-Key` header (UUID recommended)
- Ledger entries are immutable — corrections require compensating entries
- Wallet balances are always derived from `ledger_entries` (never stored directly)
- Transaction status transitions are enforced by state machine — invalid transitions throw
- Production server: `node artifacts/api-server/dist/index.cjs`
- After code changes: `pnpm --filter @workspace/api-server run build` then Publish
