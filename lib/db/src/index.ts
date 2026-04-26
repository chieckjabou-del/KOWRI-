import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

type DbInstance = ReturnType<typeof drizzle>;

let cachedPool: pg.Pool | null = null;
let cachedDb: DbInstance | null = null;

function getRuntimeDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must be set at runtime before database access.",
    );
  }
  return databaseUrl;
}

function getPool(): pg.Pool {
  if (!cachedPool) {
    cachedPool = new Pool({
      connectionString: getRuntimeDatabaseUrl(),
      max: 25,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return cachedPool;
}

function getDb(): DbInstance {
  if (!cachedDb) {
    cachedDb = drizzle(getPool(), { schema });
  }
  return cachedDb;
}

function bindProxyMember(instance: object, prop: PropertyKey) {
  const value = Reflect.get(instance, prop);
  return typeof value === "function" ? value.bind(instance) : value;
}

export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    return bindProxyMember(getPool(), prop);
  },
});

export const db = new Proxy({} as DbInstance, {
  get(_target, prop) {
    return bindProxyMember(getDb() as object, prop);
  },
});

/**
 * Creates a second Drizzle client pointed at a replica (or any alternate URL).
 * Lives here so callers don't need to depend on `pg` directly.
 */
export function createReplicaDb(replicaUrl: string) {
  const replicaPool = new Pool({ connectionString: replicaUrl, max: 10 });
  return drizzle(replicaPool, { schema });
}

export * from "./schema";
