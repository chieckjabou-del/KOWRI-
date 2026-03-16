import { Router } from "express";
import {
  generateApiKey,
  validateApiKey,
  checkKeyRateLimit,
  listApiKeys,
  revokeApiKey,
  signRequest,
  verifySignature,
  storeSecret,
  retrieveSecret,
  listSecrets,
  getSecurityPosture,
} from "../lib/security";

const router = Router();

router.get("/posture", (_req, res) => {
  res.json(getSecurityPosture());
});

router.post("/api-keys/generate", (req, res) => {
  const { label, permissions, rateLimit } = req.body;
  if (!label) return res.status(400).json({ error: "label required" });
  const result = generateApiKey(label, permissions, rateLimit);
  res.status(201).json({ ...result, label, note: "Store the secret safely — it cannot be retrieved again" });
});

router.post("/api-keys/validate", (req, res) => {
  const { keyId, secret } = req.body;
  if (!keyId || !secret) return res.status(400).json({ error: "keyId and secret required" });
  const result = validateApiKey(keyId, secret);
  if (!result.valid) return res.status(401).json({ valid: false, error: "Invalid credentials" });
  const { permissions, label, rateLimit } = result.key!;
  res.json({ valid: true, keyId, label, permissions, rateLimit });
});

router.post("/api-keys/:keyId/rate-limit", (req, res) => {
  const result = checkKeyRateLimit(req.params.keyId);
  if (!result.allowed) {
    return res.status(429).json({ ...result, error: "Rate limit exceeded" });
  }
  res.json(result);
});

router.get("/api-keys", (_req, res) => {
  res.json({ keys: listApiKeys(), count: listApiKeys().length });
});

router.delete("/api-keys/:keyId", (req, res) => {
  const ok = revokeApiKey(req.params.keyId);
  if (!ok) return res.status(404).json({ error: "Key not found" });
  res.json({ revoked: true, keyId: req.params.keyId });
});

router.post("/signing/sign", (req, res) => {
  const { payload } = req.body;
  if (!payload) return res.status(400).json({ error: "payload required" });
  const signed = signRequest(typeof payload === "string" ? payload : JSON.stringify(payload));
  res.json(signed);
});

router.post("/signing/verify", (req, res) => {
  const { payload, timestamp, nonce, signature } = req.body;
  if (!payload || !timestamp || !nonce || !signature) {
    return res.status(400).json({ error: "payload, timestamp, nonce, signature required" });
  }
  const result = verifySignature({ payload, timestamp: Number(timestamp), nonce, signature });
  if (!result.valid) return res.status(401).json({ valid: false, reason: result.reason });
  res.json({ valid: true });
});

router.post("/secrets/store", (req, res) => {
  const { label, value } = req.body;
  if (!label || !value) return res.status(400).json({ error: "label and value required" });
  const keyId = storeSecret(label, value);
  res.status(201).json({ keyId, label, stored: true });
});

router.get("/secrets/:keyId", (req, res) => {
  const value = retrieveSecret(req.params.keyId);
  if (value == null) return res.status(404).json({ error: "Secret not found" });
  res.json({ keyId: req.params.keyId, value });
});

router.get("/secrets", (_req, res) => {
  res.json({ secrets: listSecrets(), count: listSecrets().length });
});

export default router;
