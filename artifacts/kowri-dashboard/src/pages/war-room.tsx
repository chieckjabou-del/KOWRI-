import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, XCircle, RefreshCw, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

// ── API fetchers ──────────────────────────────────────────────────────────────
// OPTIMISATION OPT-002: single /api/system/snapshot call replaces 4 parallel
// useQuery calls. Reduces HTTP round-trips from 4 → 1 per 5-second poll cycle.
// ROLLBACK: revert this function to the 4 individual useQuery calls below.
const fetchJson = (url: string) => fetch(url).then(r => r.json());

const POLL_MS = 5_000;

function useWarRoomData() {
  const snapshot = useQuery({
    queryKey: ["war-room-snapshot"],
    queryFn: () => fetchJson("/api/system/snapshot"),
    refetchInterval: POLL_MS,
  });

  // Shape each sub-query to match the original { data, dataUpdatedAt } contract
  // so all downstream metric reads are unchanged.
  const wrap = (key: "health" | "outbox" | "replica" | "advisor") => ({
    data:          snapshot.data?.[key] ?? null,
    dataUpdatedAt: snapshot.dataUpdatedAt,
    isLoading:     snapshot.isLoading,
    isError:       snapshot.isError,
  });

  return {
    health:  wrap("health"),
    outbox:  wrap("outbox"),
    replica: wrap("replica"),
    advisor: wrap("advisor"),
  };
}

// ── Threshold helpers ─────────────────────────────────────────────────────────
type Status = "ok" | "warn" | "crit" | "loading";

function threshold(
  value: number | null | undefined,
  warn: number,
  crit: number,
  direction: "above" | "nonzero" = "above",
): Status {
  if (value == null) return "loading";
  if (direction === "nonzero") return value > 0 ? "crit" : "ok";
  if (value >= crit)  return "crit";
  if (value >= warn)  return "warn";
  return "ok";
}

function boolStatus(value: boolean | null | undefined, goodIs: boolean): Status {
  if (value == null) return "loading";
  return value === goodIs ? "ok" : "crit";
}

// ── Visual primitives ─────────────────────────────────────────────────────────
const STATUS_DOT: Record<Status, string> = {
  ok:      "bg-emerald-500 shadow-emerald-500/50",
  warn:    "bg-amber-400  shadow-amber-400/50",
  crit:    "bg-red-500    shadow-red-500/50 animate-pulse",
  loading: "bg-muted",
};

const STATUS_ROW_BG: Record<Status, string> = {
  ok:      "",
  warn:    "bg-amber-500/5  border-l-2 border-amber-500/40",
  crit:    "bg-red-500/8    border-l-2 border-red-500/50",
  loading: "",
};

const STATUS_VALUE: Record<Status, string> = {
  ok:      "text-emerald-400",
  warn:    "text-amber-400",
  crit:    "text-red-400",
  loading: "text-muted-foreground",
};

const GROUP_ACCENT: Record<string, string> = {
  integrity:   "border-blue-500/30   bg-blue-500/5",
  outbox:      "border-violet-500/30 bg-violet-500/5",
  database:    "border-orange-500/30 bg-orange-500/5",
  consistency: "border-cyan-500/30   bg-cyan-500/5",
};

const GROUP_ICON_COLOR: Record<string, string> = {
  integrity:   "text-blue-400",
  outbox:      "text-violet-400",
  database:    "text-orange-400",
  consistency: "text-cyan-400",
};

// ── Metric row ────────────────────────────────────────────────────────────────
function MetricRow({
  label, value, unit = "", status, sublabel,
}: {
  label: string;
  value: string | number;
  unit?: string;
  status: Status;
  sublabel?: string;
}) {
  return (
    <div className={cn(
      "flex items-center justify-between px-4 py-3 rounded-xl transition-colors",
      STATUS_ROW_BG[status],
    )}>
      <div className="flex items-center gap-3 min-w-0">
        <span className={cn(
          "w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-md",
          STATUS_DOT[status],
        )} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{label}</p>
          {sublabel && (
            <p className="text-xs text-muted-foreground truncate">{sublabel}</p>
          )}
        </div>
      </div>
      <div className="text-right flex-shrink-0 ml-4">
        <span className={cn("text-sm font-mono font-bold tabular-nums", STATUS_VALUE[status])}>
          {status === "loading" ? "—" : `${value}${unit}`}
        </span>
      </div>
    </div>
  );
}

// ── Group card ────────────────────────────────────────────────────────────────
function GroupCard({
  title, group, icon: Icon, children,
}: {
  title: string;
  group: keyof typeof GROUP_ACCENT;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      "rounded-2xl border backdrop-blur-xl p-5 flex flex-col gap-3",
      "bg-card/60 shadow-xl shadow-black/10",
      GROUP_ACCENT[group],
    )}>
      <div className="flex items-center gap-2 pb-1 border-b border-border/30">
        <Icon className={cn("w-4 h-4 flex-shrink-0", GROUP_ICON_COLOR[group])} />
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {title}
        </h2>
      </div>
      <div className="flex flex-col gap-1.5">
        {children}
      </div>
    </div>
  );
}

// ── Overall status bar ────────────────────────────────────────────────────────
function OverallStatus({ statuses }: { statuses: Status[] }) {
  const hasCrit = statuses.includes("crit");
  const hasWarn = statuses.includes("warn");
  const allLoading = statuses.every(s => s === "loading");

  const color = allLoading ? "bg-muted/50 border-border/30"
    : hasCrit ? "bg-red-500/10 border-red-500/40"
    : hasWarn ? "bg-amber-500/10 border-amber-400/40"
    : "bg-emerald-500/10 border-emerald-500/40";

  const icon = allLoading ? <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
    : hasCrit ? <XCircle className="w-4 h-4 text-red-400" />
    : hasWarn ? <AlertTriangle className="w-4 h-4 text-amber-400" />
    : <CheckCircle2 className="w-4 h-4 text-emerald-400" />;

  const label = allLoading ? "Loading…"
    : hasCrit ? "CRITICAL — Immediate action required"
    : hasWarn ? "WARNING — Monitor closely"
    : "All systems nominal";

  const textColor = allLoading ? "text-muted-foreground"
    : hasCrit ? "text-red-400"
    : hasWarn ? "text-amber-400"
    : "text-emerald-400";

  const critCount = statuses.filter(s => s === "crit").length;
  const warnCount = statuses.filter(s => s === "warn").length;

  return (
    <div className={cn("flex items-center justify-between px-5 py-3 rounded-2xl border", color)}>
      <div className="flex items-center gap-2.5">
        {icon}
        <span className={cn("text-sm font-semibold", textColor)}>{label}</span>
      </div>
      {!allLoading && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {critCount > 0 && <span className="text-red-400 font-mono">{critCount} critical</span>}
          {warnCount > 0 && <span className="text-amber-400 font-mono">{warnCount} warning</span>}
          {critCount === 0 && warnCount === 0 && (
            <span className="text-emerald-400 font-mono">12/12 healthy</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function WarRoom() {
  const { health, outbox, replica, advisor } = useWarRoomData();

  const h  = health.data  as any;
  const o  = outbox.data?.outbox as any;
  const r  = replica.data as any;
  const a  = advisor.data as any;

  // ── Correct field paths from /api/system/health response ──
  // h.latencyMs, h.components.database.status, h.components.queues.*,
  // h.components.ledger.drift
  const queues  = h?.components?.queues;
  const ledger  = h?.components?.ledger;
  const dbComp  = h?.components?.database;

  // ── Compute all 12 statuses ──
  const s = {
    // Financial integrity
    dbLatency:          threshold(h?.latencyMs,            100,  300),
    pendingSagas:       threshold(queues?.pendingSagas,     5,    20),
    openAlerts:         threshold(queues?.openFraudAlerts,  1,    5),
    // Outbox
    pendingDepth:       threshold(o?.pending,               50,   500),
    deadLetters:        threshold(o?.dead,                  1,    10),
    processingStuck:    threshold(o?.processing,            1,    5),
    // Database
    dbStatus:           h == null ? "loading" as Status
                          : (dbComp?.status === "healthy" ? "ok" : "crit") as Status,
    pendingSettlements: threshold(queues?.pendingSettlements, 10, 50),
    balanceDrift:       h == null ? "loading" as Status
                          : threshold(ledger?.drift ?? 0, 0.01, 0.01, "nonzero"),
    // Read consistency
    replicaLag:         threshold(r?.lagSec,                5,    15),
    stickyWindow:       threshold(a?.currentWindowMs,       14000, 25000),
    errorRate:          threshold(a?.errorRate != null ? a.errorRate * 100 : null, 5, 10),
  };

  const allStatuses = Object.values(s);
  const lastRefresh = health.dataUpdatedAt
    ? new Date(health.dataUpdatedAt).toLocaleTimeString()
    : null;

  const drift = ledger?.drift ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" />
            <h1 className="text-3xl font-bold tracking-tight">War Room</h1>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Real-time system health — 12 metrics · refreshes every {POLL_MS / 1000}s
          </p>
        </div>
        {lastRefresh && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-secondary/30 px-3 py-1.5 rounded-xl border border-border/30">
            <Clock className="w-3.5 h-3.5" />
            Last update: {lastRefresh}
          </div>
        )}
      </div>

      {/* Overall status banner */}
      <OverallStatus statuses={allStatuses} />

      {/* 4 metric groups — 2×2 grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Group 1 — Financial Integrity */}
        <GroupCard title="Financial Integrity" group="integrity" icon={CheckCircle2}>
          <MetricRow
            label="DB Write Latency"
            value={h?.latencyMs ?? "—"}
            unit=" ms"
            status={s.dbLatency}
            sublabel="WARN >100ms · CRIT >300ms"
          />
          <MetricRow
            label="Pending Sagas"
            value={queues?.pendingSagas ?? "—"}
            status={s.pendingSagas}
            sublabel="WARN >5 · CRIT >20"
          />
          <MetricRow
            label="Open Risk Alerts"
            value={queues?.openFraudAlerts ?? "—"}
            status={s.openAlerts}
            sublabel="WARN ≥1 · CRIT ≥5"
          />
        </GroupCard>

        {/* Group 2 — Outbox Health */}
        <GroupCard title="Outbox Health" group="outbox" icon={Activity}>
          <MetricRow
            label="Pending Queue Depth"
            value={o?.pending ?? "—"}
            status={s.pendingDepth}
            sublabel="WARN >50 · CRIT >500"
          />
          <MetricRow
            label="Dead-Letter Events"
            value={o?.dead ?? "—"}
            status={s.deadLetters}
            sublabel={o?.deadByClass
              ? Object.entries(o.deadByClass as Record<string,number>)
                  .filter(([,v]) => v > 0)
                  .map(([k,v]) => `${k}:${v}`)
                  .join(" · ") || "no DLQ entries"
              : "WARN ≥1 · CRIT ≥10"
            }
          />
          <MetricRow
            label="Processing Stuck"
            value={o?.processing ?? "—"}
            status={s.processingStuck}
            sublabel="WARN ≥1 · restart worker to recover"
          />
        </GroupCard>

        {/* Group 3 — Database Load */}
        <GroupCard title="Database Load" group="database" icon={AlertTriangle}>
          <MetricRow
            label="DB Status"
            value={dbComp?.status ?? "—"}
            status={s.dbStatus}
            sublabel={`latency ${dbComp?.latencyMs ?? "—"}ms · SELECT 1 probe`}
          />
          <MetricRow
            label="Pending Settlements"
            value={queues?.pendingSettlements ?? "—"}
            status={s.pendingSettlements}
            sublabel="WARN >10 · CRIT >50"
          />
          <MetricRow
            label="Ledger Balance Drift"
            value={drift != null ? drift.toFixed(2) : "—"}
            unit=" XOF"
            status={s.balanceDrift}
            sublabel="Any non-zero = double-spend risk"
          />
        </GroupCard>

        {/* Group 4 — Read Consistency */}
        <GroupCard title="Read Consistency" group="consistency" icon={RefreshCw}>
          <MetricRow
            label="Replica Lag"
            value={r?.lagNull ? "NULL" : (r?.lagSec ?? "—")}
            unit={r?.lagNull ? "" : " s"}
            status={r?.lagNull ? "crit" : s.replicaLag}
            sublabel="WARN >5s · CRIT >15s · NULL=MAX window"
          />
          <MetricRow
            label="Sticky Window"
            value={a?.currentWindowMs != null ? (a.currentWindowMs / 1000).toFixed(1) : "—"}
            unit=" s"
            status={s.stickyWindow}
            sublabel={`min ${(a?.minMs ?? 0) / 1000}s · max ${(a?.maxMs ?? 0) / 1000}s · ${a?.activePins ?? 0} active pins`}
          />
          <MetricRow
            label="Error Rate"
            value={a?.errorRate != null ? (a.errorRate * 100).toFixed(1) : "—"}
            unit="%"
            status={s.errorRate}
            sublabel={`p99 latency: ${a?.p99Ms ?? "—"}ms · WARN >5% · CRIT >10%`}
          />
        </GroupCard>
      </div>
    </div>
  );
}
