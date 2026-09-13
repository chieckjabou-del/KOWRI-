import { countAdmins } from "./adminAuth";

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
  if (production && !env.CORS_ORIGINS) {
    findings.push({ level: "warn", message: "CORS_ORIGINS is not set: cross-origin browser calls are refused (expected when the API serves the front-ends itself)" });
  }
  if (production && (env.DATABASE_SSL ?? "").toLowerCase() === "disable") {
    findings.push({ level: "warn", message: "DATABASE_SSL=disable in production: the PostgreSQL connection is not encrypted" });
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
