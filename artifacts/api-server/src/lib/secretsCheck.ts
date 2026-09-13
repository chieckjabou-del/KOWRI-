import { countAdmins, mfaRequired } from "./adminAuth";
import { cashInLimits, CASH_IN_LIMIT_ENV } from "./cashIn";
import { launchModulesConfigured, unknownLaunchModules } from "./launchScope";
import { alertingConfigured } from "./alerting";

// Boot-time review of the secrets the platform runs on. Findings are logged
// once; in production, errors abort startup unless SECRETS_STRICT=false.
// The rotation procedure for each secret lives in docs/SECURITY_SECRETS.md.

interface Finding { level: "error" | "warn"; message: string }

const MIN_SECRET_LENGTH = 32;

export async function reviewSecrets(env: NodeJS.ProcessEnv = process.env): Promise<Finding[]> {
  const findings: Finding[] = [];
  const production = env.NODE_ENV === "production";
  const admins = await countAdmins();

  if (!env.SIGNING_SECRET) {
    findings.push({
      level: production ? "error" : "warn",
      message: "SIGNING_SECRET is not set: request signatures use a random per-process key and stop verifying across restarts or instances",
    });
  } else if (env.SIGNING_SECRET.length < MIN_SECRET_LENGTH) {
    findings.push({ level: production ? "error" : "warn", message: `SIGNING_SECRET is shorter than ${MIN_SECRET_LENGTH} characters` });
  }

  if (env.ADMIN_API_KEY) {
    if (env.ADMIN_API_KEY.length < MIN_SECRET_LENGTH) {
      findings.push({ level: production ? "error" : "warn", message: `ADMIN_API_KEY is shorter than ${MIN_SECRET_LENGTH} characters` });
    }
    if (admins > 0) {
      findings.push({
        level: "warn",
        message: `ADMIN_API_KEY (shared legacy key) is still active while ${admins} admin account(s) exist — unset it to finish the migration to per-operator accounts`,
      });
    }
  } else if (admins === 0) {
    findings.push({
      level: production ? "error" : "warn",
      message: "No admin credential: neither ADMIN_API_KEY nor an admin account exists — set ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD for the first boot",
    });
  }

  if ((env.ADMIN_BOOTSTRAP_EMAIL || env.ADMIN_BOOTSTRAP_PASSWORD) && admins > 0) {
    findings.push({ level: "warn", message: "ADMIN_BOOTSTRAP_* variables are still set although admin accounts exist — remove them" });
  }

  if (production && env.DATABASE_URL && /localhost|127\.0\.0\.1/.test(env.DATABASE_URL)) {
    findings.push({ level: "warn", message: "DATABASE_URL points at localhost in production" });
  }
  if (!env.KYC_ENCRYPTION_KEY || !/^[0-9a-f]{64}$/i.test(env.KYC_ENCRYPTION_KEY)) {
    findings.push({
      level: production ? "error" : "warn",
      message: "KYC_ENCRYPTION_KEY missing or not a 64-hex-character key: identity documents cannot be encrypted at rest (openssl rand -hex 32)",
    });
  }
  const verification = (env.PHONE_VERIFICATION ?? (production ? "required" : "optional")).toLowerCase();
  if (production && verification !== "required") {
    findings.push({ level: "warn", message: "PHONE_VERIFICATION is not 'required': accounts can be created without proving control of the phone number" });
  }
  if (production && verification === "required" && (env.SMS_PROVIDER ?? "none").toLowerCase() === "none") {
    findings.push({ level: "error", message: "PHONE_VERIFICATION is required but no SMS provider is configured (SMS_PROVIDER=http + SMS_WEBHOOK_URL): nobody can register" });
  }
  if (production && !env.CORS_ORIGINS) {
    findings.push({ level: "warn", message: "CORS_ORIGINS is not set: cross-origin browser calls are refused (expected when the API serves the front-ends itself)" });
  }
  if (production && (env.DATABASE_SSL ?? "").toLowerCase() === "disable") {
    findings.push({ level: "warn", message: "DATABASE_SSL=disable in production: the PostgreSQL connection is not encrypted" });
  }
  if (production && !mfaRequired(env)) {
    findings.push({ level: "error", message: "ADMIN_MFA_REQUIRED=false in production: operators can move money with a password alone" });
  }
  if (production && env.ALLOW_DEMO_SEED === "true") {
    findings.push({ level: "error", message: "ALLOW_DEMO_SEED=true in production: demo accounts with a known PIN would be created" });
  }

  // ── Launch configuration ──────────────────────────────────────────────────
  // A production process must state its launch scope and its cash-in limits
  // explicitly: a forgotten variable must never silently mean "everything on"
  // or "the developer default".
  if (production && !launchModulesConfigured(env)) {
    findings.push({ level: "error", message: "LAUNCH_MODULES is not set: state the launch scope explicitly (none | all | comma-separated modules)" });
  }
  const unknown = unknownLaunchModules(env);
  if (unknown.length > 0) {
    findings.push({ level: production ? "error" : "warn", message: `LAUNCH_MODULES names unknown module(s): ${unknown.join(", ")}` });
  }
  if (production) {
    const missing = CASH_IN_LIMIT_ENV.filter((name) => !env[name] || env[name]!.trim() === "");
    if (missing.length > 0) {
      findings.push({ level: "error", message: `Cash-in limits must be set explicitly in production: ${missing.join(", ")}` });
    }
  }
  try {
    const limits = cashInLimits();
    if (limits.secondApprovalThreshold > limits.maxPerOperation) {
      findings.push({ level: production ? "error" : "warn", message: "CASH_IN_SECOND_APPROVAL_THRESHOLD is above CASH_IN_MAX_PER_OPERATION: no request would ever need a second approver" });
    }
    if (limits.maxPerOperation > limits.dailyPerInitiator || limits.maxPerOperation > limits.dailyPerBeneficiary || limits.dailyPerBeneficiary > limits.dailyPlatform || limits.dailyPerInitiator > limits.dailyPlatform) {
      findings.push({ level: production ? "error" : "warn", message: "Cash-in limits are not nested (per operation ≤ daily per operator/beneficiary ≤ daily platform)" });
    }
    if (limits.expiryHours > 72) {
      findings.push({ level: "warn", message: `CASH_IN_EXPIRY_HOURS=${limits.expiryHours}: an undecided cash-in request stays open for more than three days` });
    }
  } catch (err) {
    findings.push({ level: production ? "error" : "warn", message: `Cash-in limits are invalid: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (production && !alertingConfigured(env)) {
    findings.push({ level: "error", message: "ALERT_WEBHOOK_URL is not set: reconciliation anomalies and kill-switch events would only be written to the database, nobody would be paged" });
  }
  if (production && env.EXPERIMENTAL_MODULES && env.EXPERIMENTAL_MODULES.trim() !== "") {
    findings.push({ level: "warn", message: `EXPERIMENTAL_MODULES=${env.EXPERIMENTAL_MODULES} in production: prototype modules are exposed` });
  }
  if (production && env.SECRETS_STRICT === "false") {
    findings.push({ level: "warn", message: "SECRETS_STRICT=false: configuration errors will not stop the process" });
  }

  return findings;
}

export async function checkSecretsAtBoot(): Promise<void> {
  let findings: Finding[];
  try {
    findings = await reviewSecrets();
  } catch (err) {
    console.warn("[secrets] review skipped:", err instanceof Error ? err.message : err);
    return;
  }
  for (const f of findings) {
    (f.level === "error" ? console.error : console.warn)(`[secrets] ${f.level.toUpperCase()}: ${f.message}`);
  }
  const fatal = findings.some((f) => f.level === "error");
  if (fatal && process.env.NODE_ENV === "production" && process.env.SECRETS_STRICT !== "false") {
    console.error("[secrets] Refusing to start with insecure secrets (set SECRETS_STRICT=false to override temporarily)");
    process.exit(1);
  }
  if (findings.length === 0) console.log("[secrets] Secrets review passed");
}
