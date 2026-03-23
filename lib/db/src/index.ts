import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString:     process.env.DATABASE_URL,
  max:                  25,
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
});
export const db = drizzle(pool, { schema });

/**
 * Creates a second Drizzle client pointed at a replica (or any alternate URL).
 * Lives here so callers don't need to depend on `pg` directly.
 */
export function createReplicaDb(replicaUrl: string) {
  const replicaPool = new Pool({ connectionString: replicaUrl, max: 10 });
  return drizzle(replicaPool, { schema });
}

export * from "./schema";
