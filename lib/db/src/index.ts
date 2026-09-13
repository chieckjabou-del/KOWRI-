import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// TLS to PostgreSQL: on by default in production and whenever DATABASE_SSL is
// "require"; off for localhost/development or DATABASE_SSL=disable. Certificate
// verification stays on unless DATABASE_SSL_REJECT_UNAUTHORIZED=false (managed
// providers with self-signed chains).
function sslConfig(): false | { rejectUnauthorized: boolean } {
  const mode = (process.env.DATABASE_SSL ?? "").toLowerCase();
  if (mode === "disable" || mode === "false") return false;
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(process.env.DATABASE_URL ?? "");
  const wanted = mode === "require" || mode === "true" || (process.env.NODE_ENV === "production" && !isLocal);
  if (!wanted) return false;
  return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" };
}

export const pool = new Pool({
  connectionString:     process.env.DATABASE_URL,
  max:                  Number(process.env.DATABASE_POOL_MAX ?? 25),
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
  ssl:                  sslConfig(),
});
export const db = drizzle(pool, { schema });

/**
 * Creates a second Drizzle client pointed at a replica (or any alternate URL).
 * Lives here so callers don't need to depend on `pg` directly.
 */
export function createReplicaDb(replicaUrl: string) {
  const replicaPool = new Pool({ connectionString: replicaUrl, max: 10, ssl: sslConfig() });
  return drizzle(replicaPool, { schema });
}

export * from "./schema";
