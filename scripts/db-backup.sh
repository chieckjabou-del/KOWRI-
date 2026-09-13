#!/usr/bin/env bash
# Logical backup of the KOWRI/AKWÊ PostgreSQL database.
#
#   scripts/db-backup.sh <DATABASE_URL> <output-dir>
#
# Produces, in <output-dir>:
#   kowri-<UTC timestamp>.dump          pg_dump custom format (schema + data +
#                                        triggers + functions + the migrations
#                                        journal), compressed
#   kowri-<UTC timestamp>.dump.sha256   checksum verified by db-restore.sh
#   kowri-<UTC timestamp>.manifest.json when it was taken, server version,
#                                        migrations applied, financial row
#                                        counts and money supply per currency —
#                                        the figures a restore is checked against
#
# The dump contains ciphertext for KYC documents and TOTP secrets: it is only
# useful together with KYC_ENCRYPTION_KEY, which must be escrowed separately
# (docs/DISASTER_RECOVERY.md). It contains no plaintext credential.
set -euo pipefail

URL="${1:-${DATABASE_URL:-}}"
OUT="${2:-./backups}"
if [ -z "$URL" ]; then echo "usage: $0 <DATABASE_URL> <output-dir>" >&2; exit 2; fi
command -v pg_dump >/dev/null || { echo "pg_dump not found" >&2; exit 2; }
mkdir -p "$OUT"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$OUT/kowri-$TS"
DUMP="$BASE.dump"

# One consistent snapshot: pg_dump runs in a single REPEATABLE READ transaction.
pg_dump --format=custom --compress=6 --no-owner --no-acl --serializable-deferrable "$URL" > "$DUMP"
( cd "$OUT" && sha256sum "$(basename "$DUMP")" > "$(basename "$DUMP").sha256" )

q() { psql "$URL" -Atc "$1"; }
MIGRATIONS="$(q "select coalesce(json_agg(hash order by created_at), '[]') from drizzle.__drizzle_migrations" 2>/dev/null || echo '[]')"
SUPPLY="$(q "select coalesce(json_agg(json_build_object('currency', currency, 'created', created, 'destroyed', destroyed)), '[]') from (select currency, sum(debit_amount) created, sum(credit_amount) destroyed from ledger_entries where account_id = 'platform_float' group by currency) s")"
COUNTS="$(q "select json_build_object(
  'transactions', (select count(*) from transactions),
  'ledger_entries', (select count(*) from ledger_entries),
  'wallets', (select count(*) from wallets),
  'users', (select count(*) from users),
  'cash_in_requests', (select count(*) from cash_in_requests),
  'cash_in_executed', (select count(*) from cash_in_requests where status = 'EXECUTED'),
  'audit_logs', (select count(*) from audit_logs),
  'admin_users', (select count(*) from admin_users),
  'kyc_records', (select count(*) from kyc_records),
  'idempotency_keys', (select count(*) from idempotency_keys),
  'loans', (select count(*) from loans),
  'ledger_debits', (select coalesce(sum(debit_amount), 0) from ledger_entries),
  'ledger_credits', (select coalesce(sum(credit_amount), 0) from ledger_entries))")"

cat > "$BASE.manifest.json" <<EOF
{
  "file": "$(basename "$DUMP")",
  "sha256": "$(cut -d' ' -f1 "$DUMP.sha256")",
  "bytes": $(stat -c %s "$DUMP"),
  "takenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "serverVersion": "$(q 'show server_version')",
  "pgDumpVersion": "$(pg_dump --version | awk '{print $3}')",
  "migrations": $MIGRATIONS,
  "counts": $COUNTS,
  "moneySupply": $SUPPLY
}
EOF

echo "backup: $DUMP ($(stat -c %s "$DUMP") bytes)"
echo "manifest: $BASE.manifest.json"
