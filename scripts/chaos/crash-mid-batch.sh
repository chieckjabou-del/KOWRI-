#!/usr/bin/env bash
# Scenario: worker crash mid-batch
# Injects 60 outbox events, SIGKILLs the server after the first poll marks
# rows "processing", then verifies the next startup recovers them.
#
# Run: bash scripts/chaos/crash-mid-batch.sh

set -euo pipefail

BASE="http://localhost:8080"
DB="${DATABASE_URL}"

echo "=== Step 1: inject 60 pending outbox events ==="
psql "$DB" -q <<'SQL'
INSERT INTO outbox_events (id, topic, payload, status, attempts, priority, process_at)
SELECT
  'chaos-' || generate_series || '-' || extract(epoch from now())::bigint,
  'payment.chaos_test',
  '{"chaos": true}'::jsonb,
  'pending',
  0,
  1,
  now()
FROM generate_series(1, 60);
SQL
echo "Injected 60 rows."

echo ""
echo "=== Step 2: wait for worker to pick up the batch (poll = 5 s) ==="
sleep 6

PROCESSING=$(psql "$DB" -tAq -c "SELECT COUNT(*) FROM outbox_events WHERE status='processing' AND topic='payment.chaos_test';")
echo "Rows in 'processing': $PROCESSING"

echo ""
echo "=== Step 3: SIGKILL the server process ==="
SERVER_PID=$(pgrep -f "tsx ./src/index.ts" | head -1 || true)
if [ -z "$SERVER_PID" ]; then
  echo "Could not find server PID — is it running via tsx?"
  exit 1
fi
echo "Killing PID $SERVER_PID"
kill -9 "$SERVER_PID" 2>/dev/null || true
sleep 1

STUCK=$(psql "$DB" -tAq -c "SELECT COUNT(*) FROM outbox_events WHERE status='processing' AND topic='payment.chaos_test';")
echo "Rows still stuck in 'processing' after kill: $STUCK"

echo ""
echo "=== Step 4: restart server (replit workflow handles this) ==="
echo "Waiting 12 s for workflow restart + recoverStuckProcessing() to run..."
sleep 12

PENDING_AFTER=$(psql "$DB" -tAq -c "SELECT COUNT(*) FROM outbox_events WHERE status='pending'   AND topic='payment.chaos_test';")
PROCESSING_AFTER=$(psql "$DB" -tAq -c "SELECT COUNT(*) FROM outbox_events WHERE status='processing' AND topic='payment.chaos_test';")

echo ""
echo "=== Step 5: verify recovery ==="
echo "  pending    after restart: $PENDING_AFTER"
echo "  processing after restart: $PROCESSING_AFTER"

if [ "$PROCESSING_AFTER" -eq 0 ]; then
  echo "✅ RECOVERED — no rows stuck in processing"
else
  echo "❌ STUCK — $PROCESSING_AFTER rows never recovered"
fi

echo ""
echo "=== Cleanup ==="
psql "$DB" -q -c "DELETE FROM outbox_events WHERE topic='payment.chaos_test';"
echo "Done."
