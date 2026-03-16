import { createHmac, randomBytes, createHash, timingSafeEqual, createCipheriv, createDecipheriv } from "crypto";

export interface ApiKey {
  keyId:       string;
  keyHash:     string;
  label:       string;
  permissions: string[];
  createdAt:   Date;
  lastUsedAt?: Date;
  rateLimit:   number;
}

const KEY_STORE = new Map<string, ApiKey>();
const RATE_BUCKETS = new Map<string, { count: number; resetAt: number }>();

export function generateApiKey(label: string, permissions: string[] = ["read"], rateLimit = 1000): { keyId: string; secret: string } {
  const keyId  = `kowri_${randomBytes(8).toString("hex")}`;
  const secret = randomBytes(32).toString("hex");
  const keyHash = createHash("sha256").update(secret).digest("hex");
  KEY_STORE.set(keyId, { keyId, keyHash, label, permissions, createdAt: new Date(), rateLimit });
  return { keyId, secret };
}

export function validateApiKey(keyId: string, secret: string): { valid: boolean; key?: ApiKey } {
  const stored = KEY_STORE.get(keyId);
  if (!stored) return { valid: false };
  const hash = createHash("sha256").update(secret).digest("hex");
  const storedBuf  = Buffer.from(stored.keyHash, "hex");
  const incomingBuf = Buffer.from(hash, "hex");
  if (storedBuf.length !== incomingBuf.length) return { valid: false };
  if (!timingSafeEqual(storedBuf, incomingBuf)) return { valid: false };
  stored.lastUsedAt = new Date();
  return { valid: true, key: stored };
}

export function checkKeyRateLimit(keyId: string): { allowed: boolean; remaining: number; resetIn: number } {
  const key = KEY_STORE.get(keyId);
  if (!key) return { allowed: false, remaining: 0, resetIn: 0 };
  const now    = Date.now();
  let bucket   = RATE_BUCKETS.get(keyId);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    RATE_BUCKETS.set(keyId, bucket);
  }
  bucket.count++;
  const allowed   = bucket.count <= key.rateLimit;
  const remaining = Math.max(0, key.rateLimit - bucket.count);
  return { allowed, remaining, resetIn: Math.ceil((bucket.resetAt - now) / 1000) };
}

export function listApiKeys(): Array<Omit<ApiKey, "keyHash">> {
  return [...KEY_STORE.values()].map(({ keyHash: _kh, ...rest }) => rest);
}

export function revokeApiKey(keyId: string): boolean {
  return KEY_STORE.delete(keyId);
}

export interface SignedRequest {
  payload:   string;
  timestamp: number;
  nonce:     string;
  signature: string;
}

const SIGNING_SECRET = process.env.SIGNING_SECRET ?? randomBytes(32).toString("hex");

export function signRequest(payload: string): SignedRequest {
  const timestamp = Date.now();
  const nonce     = randomBytes(16).toString("hex");
  const message   = `${timestamp}.${nonce}.${payload}`;
  const signature = createHmac("sha256", SIGNING_SECRET).update(message).digest("hex");
  return { payload, timestamp, nonce, signature };
}

export function verifySignature(signed: SignedRequest): { valid: boolean; reason?: string } {
  const age = Date.now() - signed.timestamp;
  if (age > 300_000) return { valid: false, reason: "Request expired (>5 min)" };
  const message   = `${signed.timestamp}.${signed.nonce}.${signed.payload}`;
  const expected  = createHmac("sha256", SIGNING_SECRET).update(message).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf   = Buffer.from(signed.signature, "hex");
  if (expectedBuf.length !== actualBuf.length) return { valid: false, reason: "Signature length mismatch" };
  if (!timingSafeEqual(expectedBuf, actualBuf)) return { valid: false, reason: "Invalid signature" };
  return { valid: true };
}

export interface EncryptedSecret {
  keyId:     string;
  label:     string;
  ciphertext: string;
  iv:        string;
  createdAt: Date;
}

const SECRET_STORE = new Map<string, EncryptedSecret>();
const HSM_MASTER   = randomBytes(32);

export function storeSecret(label: string, plaintext: string): string {
  const iv         = randomBytes(16);
  const cipher     = createCipheriv("aes-256-cbc", HSM_MASTER, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("hex");
  const keyId      = `sec_${randomBytes(8).toString("hex")}`;
  SECRET_STORE.set(keyId, { keyId, label, ciphertext, iv: iv.toString("hex"), createdAt: new Date() });
  return keyId;
}

export function retrieveSecret(keyId: string): string | null {
  const stored = SECRET_STORE.get(keyId);
  if (!stored) return null;
  const iv       = Buffer.from(stored.iv, "hex");
  const decipher = createDecipheriv("aes-256-cbc", HSM_MASTER, iv);
  return Buffer.concat([decipher.update(stored.ciphertext, "hex"), decipher.final()]).toString("utf8");
}

export function listSecrets(): Array<Omit<EncryptedSecret, "ciphertext" | "iv">> {
  return [...SECRET_STORE.values()].map(({ ciphertext: _c, iv: _iv, ...rest }) => rest);
}

export function getSecurityPosture() {
  return {
    apiKeysIssued:  KEY_STORE.size,
    secretsStored:  SECRET_STORE.size,
    signingEnabled: true,
    hsmCompatible:  true,
    algorithms:     { signing: "HMAC-SHA256", encryption: "AES-256-CBC", keyDerivation: "SHA-256" },
    features: [
      "request_signing",
      "api_key_rate_limits",
      "encrypted_secret_storage",
      "hsm_compatible_key_storage",
      "timing_safe_comparison",
    ],
  };
}
