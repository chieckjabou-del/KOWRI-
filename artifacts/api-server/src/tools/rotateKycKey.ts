// ── KYC_ENCRYPTION_KEY rotation ──────────────────────────────────────────────
//
// Re-encrypts every field protected by KYC_ENCRYPTION_KEY (identity documents
// in kyc_records, TOTP secrets in admin_users) from the old key to the new
// one, in a single database transaction: either every row is on the new key
// or none is. Rows already readable with the new key are left alone, so the
// tool can be re-run after an interruption.
//
//   DATABASE_URL=… KYC_ENCRYPTION_KEY_OLD=<old keys> KYC_ENCRYPTION_KEY=<hex> \
//     npx tsx src/tools/rotateKycKey.ts [--dry-run]
//
// KYC_ENCRYPTION_KEY_OLD is a comma-separated list of candidate old keys, each
// either 64 hex characters, `dev` (the development key derived from the
// current SIGNING_SECRET) or `dev:<secret>` (derived from that secret) — a
// database written under several keys over time is rotated in one pass. A
// row none of them opens aborts the run.
// Exit code 0: rotated (or nothing to do); 1: a row could not be decrypted with
// the old key — nothing was written; 2: bad arguments.

import { pool } from "@workspace/db";
import { deriveDevKey, parseKeyHex, isEncrypted, encryptWithKey, decryptWithKey } from "../lib/fieldCrypto";

const FIELDS: Array<{ table: string; columns: string[] }> = [
  { table: "kyc_records", columns: ["document_front", "selfie", "proof_of_address", "second_document"] },
  { table: "admin_users", columns: ["mfa_secret"] },
];

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const oldKeys: Buffer[] = [];
  for (const entry of (process.env.KYC_ENCRYPTION_KEY_OLD ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const k = entry === "dev" ? deriveDevKey() : entry.startsWith("dev:") ? deriveDevKey(entry.slice(4)) : parseKeyHex(entry);
    if (!k) { console.error(`KYC_ENCRYPTION_KEY_OLD entry not understood: ${entry}`); return 2; }
    oldKeys.push(k);
  }
  const newKey = parseKeyHex(process.env.KYC_ENCRYPTION_KEY);
  if (!oldKeys.length || !newKey) {
    console.error("KYC_ENCRYPTION_KEY_OLD (64 hex, 'dev' or 'dev:<secret>', comma-separated) and KYC_ENCRYPTION_KEY (64 hex) are required");
    return 2;
  }
  if (oldKeys.some((k) => k.equals(newKey))) { console.error("old and new keys are identical"); return 2; }
  const decryptWithAnyOld = (v: string): string | null => {
    for (const k of oldKeys) { try { return decryptWithKey(v, k); } catch { /* next */ } }
    return null;
  };

  const client = await pool.connect();
  let rotated = 0, alreadyNew = 0, plaintext = 0;
  try {
    await client.query("BEGIN");
    for (const { table, columns } of FIELDS) {
      const { rows } = await client.query(`SELECT id, ${columns.join(", ")} FROM ${table} FOR UPDATE`);
      for (const row of rows) {
        const updates: string[] = []; const values: unknown[] = [];
        for (const col of columns) {
          const v = row[col] as string | null;
          if (!v) continue;
          if (!isEncrypted(v)) { plaintext++; continue; }
          try { decryptWithKey(v, newKey); alreadyNew++; continue; } catch { /* not yet on the new key */ }
          const clear = decryptWithAnyOld(v);
          if (clear === null) { console.error(`${table}.${col} row ${row.id}: not readable with the old key — aborting, nothing written`); await client.query("ROLLBACK"); return 1; }
          values.push(encryptWithKey(clear, newKey));
          updates.push(`${col} = $${values.length}`);
        }
        if (updates.length) {
          values.push(row.id);
          await client.query(`UPDATE ${table} SET ${updates.join(", ")} WHERE id = $${values.length}`, values);
          rotated += updates.length;
        }
      }
    }
    if (dryRun) { await client.query("ROLLBACK"); console.log(`dry run: ${rotated} field(s) would be rotated, ${alreadyNew} already on the new key, ${plaintext} legacy plaintext`); return 0; }
    await client.query("COMMIT");
    console.log(`rotated ${rotated} field(s); ${alreadyNew} already on the new key; ${plaintext} legacy plaintext field(s) left as is`);
    return 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
