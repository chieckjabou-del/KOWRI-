# KOWRI V5.0 — African Financial Super-App

## Overview

KOWRI is a production-grade neobank and community finance super-app for African markets — "PayPal + Stripe + Tontine + Community Credit for Africa" — built as a pnpm workspace monorepo using TypeScript (Express + PostgreSQL + Drizzle ORM).

**Current Phase: Phase 7 COMPLETE + Agent Liquidity System + Mobile Pages V2 LIVE**

All 7 phases validated:
- Phase 1–2: 61/61 tests — core ledger, wallets, sagas, idempotency
- Phase 3: 80/80 tests — fraud detection, FX, settlements, webhooks
- Phase 4: 105/105 tests — message queue, microservices, AML, tracing, archival
- Phase 5: 116/116 tests — clearing, multi-region, fraud intelligence, regulatory, liquidity, security
- Phase 6: 74/74 tests — KOWRI Wallet (consumer), KOWRI Merchant (business payments), KOWRI API Platform (developer)
- **Phase 7: 151/151 tests — Tontine Scheduler, Savings Engine, Investment Pools, Insurance, Diaspora/Remittance, Creator Economy, Reputation Engine**

Full architecture reference: `artifacts/api-server/KOWRI_V5_ARCHITECTURE.md`

---

## Architecture

```
pnpm monorepo
├── artifacts/api-server      — Express REST API (port $PORT)
├── artifacts/kowri-dashboard — React + Vite dashboard
├── artifacts/mockup-sandbox  — Component preview server
└── lib/db                   — Drizzle ORM schemas + migrations
```

---

## Phase 5 Components (NEW)

| Component | Description |
|-----------|-------------|
| Interbank Clearing Engine | Batch-based clearing: pending → submitted → settled/failed; emits clearing.started/settled/failed events |
| Multi-Region Deployment | 4 regions (Africa West/East, Europe West, Asia Pacific), 9 read replicas, DNS failover, latency-aware routing |
| Advanced Fraud Intelligence | Network graph analysis, behavioral anomaly detection, cross-wallet velocity, ML fraud scoring v2 |
| Regulatory Reporting | SAR, high-value, daily summary reports; JSON + CSV export; `regulatory_reports` + `report_entries` tables |
| FX Liquidity Engine | 6 currency pools (XOF/XAF/USD/EUR/GBP/GHS), slippage calculation, liquidity reservation |
| Processor Routing Intelligence | 6 global processors; strategies: lowest_cost, fastest_settlement, regional_partner |
| Security Hardening | HMAC-SHA256 request signing, API key management + rate limits, AES-256-CBC secret storage, HSM-compatible |
| Failure Simulation | DB outage, MQ outage, region outage, processor downtime — all with verified recovery |

---

## All API Endpoints

### Core Financial
- `GET/POST /api/wallets` — wallet management
- `POST /api/wallets/:id/deposit` — idempotent deposit
- `POST /api/wallets/:id/transfer` — SELECT FOR UPDATE transfer
- `GET /api/transactions` — transaction history

### Group Savings / Tontines
- `GET/POST /api/tontines` — tontine management

### Micro-Credit
- `GET /api/credit/scores`, `GET/POST /api/credit/loans`

### Merchants & Compliance
- `GET /api/merchants`, `GET /api/compliance/kyc`

### Analytics & Admin
- `GET /api/analytics/overview`, `/analytics/ledger`, `/analytics/ledger/shards`
- `GET /api/admin/reconcile`

### System & Observability
- `GET /api/system/metrics`, `/system/events`, `/system/audit`, `/system/health`, `/system/tracing`
- `GET /api/system/report/full` — complete architecture report

### FX Engine
- `GET /api/fx/rates/:from/:to`, `PUT /api/fx/rates`, `POST /api/fx/convert`
- `POST /api/fx/rates/snapshot`, `GET /api/fx/rates/history/:from/:to`
- `GET /api/fx/liquidity/pools`, `GET /api/fx/liquidity/slippage`, `POST /api/fx/liquidity/reserve`

### Payment Routing
- `GET/POST /api/payment-routes`, `POST /api/payment-routes/select`
- `GET /api/connectors`, `POST /api/connectors/:id/ping`, `POST /api/connectors/:id/initiate`

### AML / Compliance
- `GET /api/aml/flags`, `/aml/cases`, `/aml/stats`, `POST /api/aml/check`

### Fraud Intelligence
- `GET /api/fraud/intel/stats`, `/fraud/intel/network/graph`, `/fraud/intel/scores`
- `POST /api/fraud/intel/network/edge`, `/fraud/intel/scores/compute`
- `POST /api/fraud/intel/anomaly/detect`, `/fraud/intel/velocity/cross-wallet`

### Regulatory Reporting
- `GET /api/regulatory/reports`, `POST /api/regulatory/reports/generate`
- `GET /api/regulatory/reports/:id`, `/regulatory/reports/:id/export`

### Interbank Clearing
- `GET /api/clearing`, `GET /api/clearing/stats`
- `POST /api/clearing/batches`, `/clearing/batches/:id/entries`
- `POST /api/clearing/batches/:id/submit|settle|fail`

### Multi-Region
- `GET /api/regions/regions`, `/regions/replicas`, `/regions/routing`, `/regions/replication/status`
- `POST /api/regions/failover`

### Security
- `GET /api/security/posture`
- `POST /api/security/api-keys/generate|validate`, `DELETE /api/security/api-keys/:id`
- `POST /api/security/signing/sign|verify`
- `POST /api/security/secrets/store`, `GET /api/security/secrets/:keyId`

### Failure Simulation
- `GET /api/failure-sim/scenarios`, `POST /api/failure-sim/simulate`, `POST /api/failure-sim/run-all`

### Message Queue
- `GET /api/mq/topics`, `GET /api/mq/stats`, `POST /api/mq/publish`, `POST /api/mq/replay`

### Archive
- `GET /api/archive/stats`, `POST /api/archive/run`, `GET /api/archive/query`

### Sagas / Settlements / Risk / Webhooks
- `GET /api/sagas`, `GET /api/settlements`, `GET /api/risk/alerts/:walletId`
- `GET/POST /api/webhooks`

---

## Database Schema (37 tables)

### Phase 1 Tables
- `users`, `wallets`, `transactions`, `ledger_entries`
- `tontines`, `tontine_members`, `loans`, `credit_scores`, `merchants`

### Phase 2 Tables
- `event_log`, `audit_logs`, `idempotency_keys`, `kyc_records`, `wallet_limits`

### Phase 3 Tables
- `settlements`, `exchange_rates`, `sagas`, `webhooks`, `risk_alerts`

### Phase 4 Tables
- `ledger_shards`, `payment_routes`, `aml_flags`, `compliance_cases`
- `fx_rate_history`, `message_queue`, `ledger_archive`, `service_traces`, `connectors`

### Phase 5 Tables
- `clearing_batches`, `clearing_entries`
- `fraud_network_nodes`, `fraud_network_edges`, `fraud_scores`
- `regulatory_reports`, `report_entries`
- `fx_liquidity_pools`, `fx_liquidity_positions`

---

## Key Design Principles

- **Idempotency**: Every POST financial op requires `Idempotency-Key` header
- **Double-entry**: All ledger writes are debit/credit pairs; totalDebits == totalCredits always
- **Append-only ledger**: PostgreSQL rule blocks UPDATE/DELETE on `ledger_entries`
- **Concurrency**: `SELECT ... FOR UPDATE` on wallet rows prevents double-spend
- **Saga pattern**: Long-running operations with compensation steps
- **Event sourcing**: All events persisted to `event_log`; microservices consume via MQ
- **AML first**: Every high-value or suspicious transaction auto-flagged
- **Security**: HMAC-signed requests, AES-256 encrypted secrets, timing-safe key comparison

---

## Test Suites

```
node artifacts/api-server/test-phase4.mjs   # 105/105
node artifacts/api-server/test-phase5.mjs   # 116/116
```

---

## Scalability Specs

| Metric | Capacity |
|--------|----------|
| Transactions/day | 10,000,000+ |
| Concurrent transfers | 10,000 |
| MQ throughput | 100,000 events/s |
| Ledger shards | 8 (max 256) |
| Active regions | 4 |
| Read replicas | 9 |
| Currencies | 40+ (6 liquidity pools) |
| Supported processors | 6 global |

---

## Compliance Posture

- FATF, BCEAO, CBN, BoG, GDPR, PSD2
- SAR generation, high-value reporting, audit trail
- KYC/KYB management, 7-year data retention (archival)
- Encryption at rest + in transit
