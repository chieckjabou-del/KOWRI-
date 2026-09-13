// ── Field-level encryption at rest ──────────────────────────────────────────
// Identity documents (base64 images) are stored in PostgreSQL. Encrypting each
// field with AES-256-GCM means a database dump, a replica or a SQL injection
// yields ciphertext only; the key lives with the API process
// (KYC_ENCRYPTION_KEY, 32 bytes hex). Values are prefixed so legacy plaintext
// rows keep reading until they are re-submitted or migrated.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const PREFIX = "enc:v1:";

function key(): Buffer {
  const hex = process.env.KYC_ENCRYPTION_KEY;
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  if (process.env.NODE_ENV === "production") {
    throw new Error("KYC_ENCRYPTION_KEY must be a 64-hex-character (32-byte) key in production");
  }
  // Development only: derive a stable key from SIGNING_SECRET (or a fixed dev value).
  return createHash("sha256").update(`kowri-dev-kyc:${process.env.SIGNING_SECRET ?? "dev"}`).digest();
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (isEncrypted(value)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isEncrypted(value)) return value;            // legacy plaintext row
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
