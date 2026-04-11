import bcrypt from "bcryptjs";
import { createHash } from "crypto";

const BCRYPT_ROUNDS = 12;

export function normalizePhone(phone: string): string {
  return String(phone ?? "").replace(/\s+/g, "").trim();
}

export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

// Supports legacy SHA-256 rows while migrating to bcrypt.
export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  if (storedHash.startsWith("$2a$") || storedHash.startsWith("$2b$") || storedHash.startsWith("$2y$")) {
    return bcrypt.compare(pin, storedHash);
  }
  const legacyHash = createHash("sha256").update(String(pin)).digest("hex");
  return storedHash === legacyHash;
}
