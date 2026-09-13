// ── Route gating suite ────────────────────────────────────────────────────────
// Enumerates every route mounted by src/routes/index.ts (plus the ad-hoc routes
// in src/app.ts), calls each one WITHOUT any credential, and fails when a route
// that is not on the public allowlist answers anything other than 401/403.
//
// Run against a live server:  node test-gating.mjs   (BASE defaults to :8080)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://localhost:8080/api";

// Routes that are legitimately reachable without a credential.
const PUBLIC = [
  ["GET",  /^\/health(z)?$/],
  ["GET",  /^\/health\/launch-scope$/],      // launch scope and kill switch states (no secrets)
  ["POST", /^\/users$/],                       // registration
  ["POST", /^\/users\/login$/],
  ["POST", /^\/auth\/login$/],
  ["GET",  /^\/auth\/otp\/policy$/],           // phone verification before registration
  ["POST", /^\/auth\/otp\/(request|verify)$/],
  ["POST", /^\/wallet\/(login|create|logout)$/], // logout without a token is a no-op
  ["POST", /^\/merchant\/(login|create)$/],
  ["POST", /^\/developer\/(register|login)$/],
  ["POST", /^\/developer\/api-key\/validate$/], // validates the key it is given
  ["GET",  /^\/developer\/(docs|sandbox)$/],
  ["GET",  /^\/fx\/rates/],                    // published rates, read-only
  ["GET",  /^\/tontines\/public$/],            // public tontine catalogue
  ["POST", /^\/admin\/auth\/login$/],
];

function isPublic(method, path) {
  return PUBLIC.some(([m, re]) => m === method && re.test(path));
}

// ── Static route discovery ────────────────────────────────────────────────────

const indexSrc = readFileSync(join(here, "src/routes/index.ts"), "utf8");
const importMap = new Map();
for (const m of indexSrc.matchAll(/import\s+(\w+)\s+from\s+"\.\/(\w+)"/g)) importMap.set(m[1], m[2]);

const mounts = [];
for (const m of indexSrc.matchAll(/router\.use\(\s*"([^"]+)"\s*,([^;]*?)(\w+Router)\s*\)/g)) {
  mounts.push({ prefix: m[1], file: importMap.get(m[3]) });
}
for (const m of indexSrc.matchAll(/router\.use\((\w+Router)\)/g)) {
  mounts.push({ prefix: "", file: importMap.get(m[1]) });
}

const ROUTE_RE = /router\.(get|post|put|patch|delete|all)\(\s*"([^"]+)"/g;
const routes = [];
for (const { prefix, file } of mounts) {
  if (!file) continue;
  const src = readFileSync(join(here, `src/routes/${file}.ts`), "utf8");
  for (const m of src.matchAll(ROUTE_RE)) {
    const method = m[1] === "all" ? "POST" : m[1].toUpperCase();
    const raw = (prefix + (m[2] === "/" ? "" : m[2])) || "/";
    routes.push({ method, file, raw });
  }
}
const appSrc = readFileSync(join(here, "src/app.ts"), "utf8");
for (const m of appSrc.matchAll(/app\.(get|post|put|patch|delete)\(\s*"\/api([^"]*)"/g)) {
  routes.push({ method: m[1].toUpperCase(), file: "app", raw: m[2] || "/" });
}

function concretePath(raw) {
  return raw
    .replace(/\{\*\w+\}/g, "probe")            // Express 5 wildcards
    .replace(/:\w+/g, "probe-id")
    .replace(/\/+$/, "") || "/";
}

// ── Probe ─────────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const failures = [];

for (const r of routes) {
  const path = concretePath(r.raw);
  const method = r.method;
  const init = { method, headers: {} };
  if (method !== "GET" && method !== "DELETE") {
    init.headers["Content-Type"] = "application/json";
    init.body = "{}";
  }
  let status = 0;
  try { status = (await fetch(BASE + path, init)).status; } catch { status = 0; }

  const pub = isPublic(method, path);
  const ok = pub ? status !== 0 && status !== 500 : status === 401 || status === 403;
  if (ok) pass++;
  else { fail++; failures.push(`${method.padEnd(6)} ${path.padEnd(55)} -> ${status}  (${r.file}.ts)`); }
}

console.log(`\nRoute gating: ${routes.length} routes probed without credentials — ${pass} ok, ${fail} open`);
if (failures.length) {
  console.log("\nRoutes answering without a credential (expected 401/403):");
  for (const f of failures) console.log("  " + f);
}
process.exit(fail ? 1 : 0);
