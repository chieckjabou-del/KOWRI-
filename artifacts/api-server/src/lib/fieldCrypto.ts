// ── Field-level encryption at rest ──────────────────────────────────────────
// Identity documents (base64 images) are stored in PostgreSQL. Encrypting each
// field with AES-256-GCM means a database dump, a replica or a SQL injection
// yields ciphertext only; the key lives with the API process
// (KYC_ENCRYPTION_KEY, 32 bytes hex). Values are prefixed so legacy plaintext
// rows keep reading until they are re-submitted or migrated.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const PREFIX = "enc:v1:";

// Development only: a stable key derived from SIGNING_SECRET, so a local
// database stays readable across restarts without a real key.
export function deriveDevKey(signingSecret: string | undefined = process.env.SIGNING_SECRET): Buffer {
  return createHash("sha256").update(`kowri-dev-kyc:${signingSecret ?? "dev"}`).digest();
}

export function parseKeyHex(hex: string | undefined): Buffer | null {
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  return null;
}

function key(): Buffer {
  const configured = parseKeyHex(process.env.KYC_ENCRYPTION_KEY);
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("KYC_ENCRYPTION_KEY must be a 64-hex-character (32-byte) key in production");
  }
  return deriveDevKey();
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptWithKey(value: string, k: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

// Throws when the key is wrong (GCM authentication fails): a ciphertext never
// silently decrypts to garbage.
export function decryptWithKey(value: string, k: Buffer): string {
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function encryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (isEncrypted(value)) return value;
  return encryptWithKey(value, key());
}

export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isEncrypted(value)) return value;            // legacy plaintext row
  return decryptWithKey(value, key());
}
