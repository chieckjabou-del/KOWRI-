import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";

const SCRYPT_KEYLEN = 32;
const SCRYPT_PREFIX = "scrypt";

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(String(pin), salt, SCRYPT_KEYLEN);
  return `${SCRYPT_PREFIX}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

// Accepts both the new salted scrypt format and the legacy unsalted sha256 hex
// so existing accounts keep working; callers should rehash on successful login.
export function verifyPin(pin: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const value = String(pin);

  if (storedHash.startsWith(`${SCRYPT_PREFIX}$`)) {
    const [, saltHex, hashHex] = storedHash.split("$");
    if (!saltHex || !hashHex) return false;
    const derived = scryptSync(value, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN);
    return safeEqualHex(derived.toString("hex"), hashHex);
  }

  const legacy = createHash("sha256").update(value).digest("hex");
  return safeEqualHex(legacy, storedHash);
}

export function isLegacyPinHash(storedHash: string | null | undefined): boolean {
  return !!storedHash && !storedHash.startsWith(`${SCRYPT_PREFIX}$`);
}

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4,6}$/.test(pin);
}
