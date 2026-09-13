#!/usr/bin/env bash
# Restores a db-backup.sh dump into an EMPTY database and checks it against the
# manifest that was written with the backup.
#
#   scripts/db-restore.sh <dump-file> <TARGET_DATABASE_URL>
#
# Refuses to run when the checksum does not match the .sha256 sidecar, or when
# the target already contains a ledger (a restore never overwrites live money).
# After the restore, row counts, migrations and money supply are compared with
# the manifest; any difference makes the script exit non-zero.
#
# The database itself must exist (CREATE DATABASE needs a maintenance
# connection the application role does not have in production):
#   psql "$MAINTENANCE_URL" -c 'create database kowri_restore owner kowri'
set -euo pipefail

DUMP="${1:-}"
TARGET="${2:-}"
if [ -z "$DUMP" ] || [ -z "$TARGET" ]; then echo "usage: $0 <dump-file> <TARGET_DATABASE_URL>" >&2; exit 2; fi
[ -f "$DUMP" ] || { echo "dump not found: $DUMP" >&2; exit 2; }
command -v pg_restore >/dev/null || { echo "pg_restore not found" >&2; exit 2; }

DIR="$(dirname "$DUMP")"; FILE="$(basename "$DUMP")"
MANIFEST="$DIR/${FILE%.dump}.manifest.json"

# 1. Integrity of the file.
[ -f "$DUMP.sha256" ] || { echo "missing checksum $DUMP.sha256" >&2; exit 3; }
EXPECTED_SHA="$(cut -d' ' -f1 "$DUMP.sha256")"
ACTUAL_SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
[ -n "$EXPECTED_SHA" ] && [ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || { echo "CHECKSUM MISMATCH: refusing to restore $DUMP" >&2; exit 3; }
echo "checksum ok"

# 2. The target must be empty of money.
q() { psql "$TARGET" -Atc "$1"; }
if [ "$(q "select count(*) from pg_tables where schemaname = 'public' and tablename = 'ledger_entries'")" = "1" ]; then
  if [ "$(q 'select count(*) from ledger_entries')" != "0" ]; then
    echo "target already holds ledger entries: refusing to restore over live data" >&2; exit 4
  fi
fi

# 3. Restore schema, data, functions, triggers, and the migrations journal.
pg_restore --no-owner --no-acl --exit-on-error --dbname="$TARGET" "$DUMP"
echo "restore complete"

# 4. Compare with the manifest.
if [ -f "$MANIFEST" ]; then
  EXPECTED="$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(json.dumps({"counts": m["counts"], "migrations": m["migrations"], "moneySupply": m["moneySupply"]}, sort_keys=True))' "$MANIFEST")"
  ACTUAL="$(python3 - "$TARGET" <<'PY'
import json, subprocess, sys
url = sys.argv[1]
def q(s): return subprocess.check_output(["psql", url, "-Atc", s], text=True).strip()
counts = json.loads(q("""select json_build_object(
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
  'ledger_credits', (select coalesce(sum(credit_amount), 0) from ledger_entries))"""))
migrations = json.loads(q("select coalesce(json_agg(hash order by created_at), '[]') from drizzle.__drizzle_migrations"))
supply = json.loads(q("select coalesce(json_agg(json_build_object('currency', currency, 'created', created, 'destroyed', destroyed)), '[]') from (select currency, sum(debit_amount) created, sum(credit_amount) destroyed from ledger_entries where account_id = 'platform_float' group by currency) s"))
print(json.dumps({"counts": counts, "migrations": migrations, "moneySupply": supply}, sort_keys=True))
PY
)"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "MANIFEST MISMATCH after restore" >&2
    echo "expected: $EXPECTED" >&2
    echo "actual:   $ACTUAL" >&2
    exit 5
  fi
  echo "manifest verified: counts, migrations and money supply match"
else
  echo "no manifest next to the dump: restored without comparison" >&2
fi
