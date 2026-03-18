import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, CheckCircle2, XCircle, RefreshCw, Clock,
  Cpu, Zap, Shield, Bot, TrendingUp, TrendingDown, Minus, BarChart3,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── API fetchers ───────────────────────────────────────────────────────────────
const fetchJson = (url: string) => fetch(url).then(r => r.json());
const POLL_MS   = 5_000;

// ── Infrastructure snapshot (existing) ────────────────────────────────────────
function useWarRoomData() {
  const snapshot = useQuery({
    queryKey: ["war-room-snapshot"],
    queryFn:  () => fetchJson("/api/system/snapshot"),
    refetchInterval: POLL_MS,
  });
  const wrap = (key: "health" | "outbox" | "replica" | "advisor") => ({
    data:          snapshot.data?.[key] ?? null,
    dataUpdatedAt: snapshot.dataUpdatedAt,
    isLoading:     snapshot.isLoading,
    isError:       snapshot.isError,
  });
  return { health: wrap("health"), outbox: wrap("outbox"), replica: wrap("replica"), advisor: wrap("advisor") };
}

// ── Autopilot snapshot (new) ───────────────────────────────────────────────────
function useAutopilotData() {
  const q = useQuery({
    queryKey: ["warroom-autopilot"],
    queryFn:  () => fetchJson("/api/warroom/snapshot"),
    refetchInterval: POLL_MS,
  });
  return {
    status:    q.data?.status    ?? null,
    metrics:   q.data?.metrics   ?? null,
    incidents: q.data?.incidents ?? null,
    isLoading: q.isLoading,
    isError:   q.isError,
    updatedAt: q.dataUpdatedAt,
  };
}

// ── Threshold helpers ──────────────────────────────────────────────────────────
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
  autopilot:   "border-emerald-500/30 bg-emerald-500/5",
  engine:      "border-indigo-500/30  bg-indigo-500/5",
  incidents:   "border-rose-500/30    bg-rose-500/5",
  stream:      "border-teal-500/30    bg-teal-500/5",
};

const GROUP_ICON_COLOR: Record<string, string> = {
  integrity:   "text-blue-400",
  outbox:      "text-violet-400",
  database:    "text-orange-400",
  consistency: "text-cyan-400",
  autopilot:   "text-emerald-400",
  engine:      "text-indigo-400",
  incidents:   "text-rose-400",
  stream:      "text-teal-400",
};

// ── Metric row ─────────────────────────────────────────────────────────────────
function MetricRow({ label, value, unit = "", status, sublabel }: {
  label: string; value: string | number; unit?: string; status: Status; sublabel?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between px-4 py-3 rounded-xl transition-colors", STATUS_ROW_BG[status])}>
      <div className="flex items-center gap-3 min-w-0">
        <span className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-md", STATUS_DOT[status])} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{label}</p>
          {sublabel && <p className="text-xs text-muted-foreground truncate">{sublabel}</p>}
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

// ── Group card ─────────────────────────────────────────────────────────────────
function GroupCard({ title, group, icon: Icon, children }: {
  title: string; group: keyof typeof GROUP_ACCENT; icon: React.ElementType; children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-2xl border backdrop-blur-xl p-5 flex flex-col gap-3", "bg-card/60 shadow-xl shadow-black/10", GROUP_ACCENT[group])}>
      <div className="flex items-center gap-2 pb-1 border-b border-border/30">
        <Icon className={cn("w-4 h-4 flex-shrink-0", GROUP_ICON_COLOR[group])} />
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h2>
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

// ── Overall status bar ─────────────────────────────────────────────────────────
function OverallStatus({ statuses }: { statuses: Status[] }) {
  const hasCrit   = statuses.includes("crit");
  const hasWarn   = statuses.includes("warn");
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
          {critCount === 0 && warnCount === 0 && <span className="text-emerald-400 font-mono">12/12 healthy</span>}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// NEW AUTOPILOT COMPONENTS
// ════════════════════════════════════════════════════════════════

// ── Inline SVG sparkline ──────────────────────────────────────────────────────
function Sparkline({ data, color = "currentColor" }: { data: number[]; color?: string }) {
  if (data.length < 2) {
    return <span className="text-muted-foreground font-mono text-xs">no data</span>;
  }
  const max = Math.max(...data, 0.001);
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * 100},${(1 - v / max) * 28}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 100 28`} className="w-28 h-7" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Strategy mode badge ───────────────────────────────────────────────────────
const MODE_STYLE: Record<string, string> = {
  BALANCED:        "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
  LATENCY_FIRST:   "bg-blue-500/15    text-blue-300    border border-blue-500/30",
  THROUGHPUT_FIRST:"bg-amber-500/15   text-amber-300   border border-amber-500/30",
};

function ModeBadge({ mode }: { mode: string | null | undefined }) {
  if (!mode) return <span className="text-muted-foreground text-xs">—</span>;
  const label = mode === "LATENCY_FIRST" ? "LATENCY" : mode === "THROUGHPUT_FIRST" ? "THROUGHPUT" : "BALANCED";
  return (
    <span className={cn("px-3 py-1 rounded-full text-xs font-bold tracking-widest font-mono", MODE_STYLE[mode] ?? MODE_STYLE.BALANCED)}>
      {label}
    </span>
  );
}

// ── Kill switch badge ─────────────────────────────────────────────────────────
const SWITCH_DOT: Record<string, string> = {
  ENABLED:    "bg-emerald-500",
  TRIGGERED:  "bg-red-500 animate-pulse",
  FORCED_OFF: "bg-red-500",
};
const SWITCH_TEXT: Record<string, string> = {
  ENABLED:    "text-emerald-400",
  TRIGGERED:  "text-red-400",
  FORCED_OFF: "text-red-400",
};

function KillSwitchRow({ name, state, reason }: { name: string; state: string; reason?: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-white/3 transition-colors">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={cn("w-2 h-2 rounded-full flex-shrink-0 shadow-md", SWITCH_DOT[state] ?? "bg-muted")} />
        <span className="text-xs font-mono text-foreground truncate">{name.replace(/_/g, " ")}</span>
      </div>
      <span className={cn("text-xs font-bold font-mono flex-shrink-0 ml-3", SWITCH_TEXT[state] ?? "text-muted-foreground")}>
        {state}
      </span>
    </div>
  );
}

// ── Metrics sparkline card ────────────────────────────────────────────────────
const METRIC_META: Record<string, { label: string; unit: string; warnAt: number; critAt: number; color: string }> = {
  db_latency:     { label: "DB Latency",     unit: "ms",  warnAt: 100,  critAt: 300,  color: "#60a5fa" },
  outbox_pending: { label: "Outbox Pending", unit: "",    warnAt: 50,   critAt: 500,  color: "#a78bfa" },
  dlq_rate:       { label: "DLQ Rate",       unit: "",    warnAt: 1,    critAt: 10,   color: "#f472b6" },
  balance_drift:  { label: "Balance Drift",  unit: " XOF",warnAt: 0.01, critAt: 0.01, color: "#fb923c" },
  replica_lag:    { label: "Replica Lag",    unit: "s",   warnAt: 5,    critAt: 15,   color: "#34d399" },
};

function SparklineCard({ metricKey, points }: { metricKey: string; points: { value: number; timestamp: string }[] }) {
  const meta    = METRIC_META[metricKey];
  const current = points.length > 0 ? points[points.length - 1].value : null;
  const values  = points.map(p => p.value);
  const trend   = values.length >= 2
    ? values[values.length - 1] > values[values.length - 2] ? "up"
    : values[values.length - 1] < values[values.length - 2] ? "down"
    : "flat"
    : "flat";

  const status: Status = current == null ? "loading"
    : threshold(current, meta?.warnAt ?? 0, meta?.critAt ?? 0, metricKey === "balance_drift" ? "nonzero" : "above");

  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor = metricKey === "db_latency" || metricKey === "outbox_pending" || metricKey === "dlq_rate"
    ? (trend === "up" ? "text-red-400" : trend === "down" ? "text-emerald-400" : "text-muted-foreground")
    : "text-muted-foreground";

  return (
    <div className={cn(
      "rounded-2xl border bg-card/60 backdrop-blur-xl p-4 flex flex-col gap-3 shadow-xl shadow-black/10",
      status === "crit" ? "border-red-500/30 bg-red-500/5"
      : status === "warn" ? "border-amber-500/30 bg-amber-500/5"
      : "border-teal-500/30 bg-teal-500/5",
    )}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{meta?.label ?? metricKey}</span>
        <TrendIcon className={cn("w-3.5 h-3.5", trendColor)} />
      </div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <span className={cn("text-2xl font-mono font-bold tabular-nums", STATUS_VALUE[status])}>
            {current != null ? current.toFixed(2) : "—"}
          </span>
          <span className="text-xs text-muted-foreground ml-1">{meta?.unit}</span>
        </div>
        <div className={cn("opacity-70", STATUS_VALUE[status])}>
          <Sparkline data={values} color={meta?.color ?? "currentColor"} />
        </div>
      </div>
      <div className="text-xs text-muted-foreground font-mono">
        {points.length} samples · WARN ≥{meta?.warnAt} · CRIT ≥{meta?.critAt}
      </div>
    </div>
  );
}

// ── Incident row ──────────────────────────────────────────────────────────────
const INCIDENT_TYPE_COLOR: Record<string, string> = {
  latency_spike:    "bg-amber-500/15 text-amber-300",
  stuck_worker:     "bg-red-500/15   text-red-300",
  latency_ok:       "bg-emerald-500/15 text-emerald-300",
  global_evaluator: "bg-blue-500/15  text-blue-300",
  strategy_engine:  "bg-violet-500/15 text-violet-300",
  healing:          "bg-orange-500/15 text-orange-300",
};

function typeColor(type: string) {
  return INCIDENT_TYPE_COLOR[type] ?? "bg-muted/30 text-muted-foreground";
}

function IncidentRow({ type, action, result, createdAt }: {
  type: string; action: string; result: string; createdAt: string;
}) {
  const t  = new Date(createdAt);
  const ts = `${t.getHours().toString().padStart(2,"0")}:${t.getMinutes().toString().padStart(2,"0")}:${t.getSeconds().toString().padStart(2,"0")}`;
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl hover:bg-white/3 transition-colors border-b border-border/10 last:border-0">
      <div className="flex-shrink-0 pt-0.5">
        <span className={cn("px-2 py-0.5 rounded-md text-xs font-bold font-mono", typeColor(type))}>
          {type.replace(/_/g, " ")}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono text-foreground/80 truncate">{action}</p>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{result}</p>
      </div>
      <span className="text-xs font-mono text-muted-foreground flex-shrink-0 tabular-nums">{ts}</span>
    </div>
  );
}

// ── Suppression chip ──────────────────────────────────────────────────────────
function SuppressionList({ suppressions }: { suppressions: Record<string, { expiresAtCycle: number; remainingCycles: number }> }) {
  const entries = Object.entries(suppressions ?? {});
  if (entries.length === 0) {
    return <span className="text-emerald-400 text-xs font-mono">none — all modes active</span>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([mode, { remainingCycles }]) => (
        <span key={mode} className="px-2 py-0.5 rounded-md text-xs font-mono bg-red-500/15 text-red-300 border border-red-500/20">
          {mode} blocked · {remainingCycles} cycle{remainingCycles !== 1 ? "s" : ""}
        </span>
      ))}
    </div>
  );
}

// ── Learning confidence bar ───────────────────────────────────────────────────
function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-muted";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-border/30 overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-muted-foreground tabular-nums w-8 text-right">{pct}%</span>
    </div>
  );
}


// ── Main page ──────────────────────────────────────────────────────────────────
export default function WarRoom() {
  const { health, outbox, replica, advisor } = useWarRoomData();
  const { status, metrics, incidents, isLoading: apLoading, updatedAt } = useAutopilotData();

  const h = health.data  as any;
  const o = outbox.data?.outbox as any;
  const r = replica.data as any;
  const a = advisor.data as any;

  const queues = h?.components?.queues;
  const ledger = h?.components?.ledger;
  const dbComp = h?.components?.database;

  const s = {
    dbLatency:          threshold(h?.latencyMs,              100,  300),
    pendingSagas:       threshold(queues?.pendingSagas,      5,    20),
    openAlerts:         threshold(queues?.openFraudAlerts,   1,    5),
    pendingDepth:       threshold(o?.pending,                50,   500),
    deadLetters:        threshold(o?.dead,                   1,    10),
    processingStuck:    threshold(o?.processing,             1,    5),
    dbStatus:           h == null ? "loading" as Status : (dbComp?.status === "healthy" ? "ok" : "crit") as Status,
    pendingSettlements: threshold(queues?.pendingSettlements, 10,  50),
    balanceDrift:       h == null ? "loading" as Status : threshold(ledger?.drift ?? 0, 0.01, 0.01, "nonzero"),
    replicaLag:         threshold(r?.lagSec,                 5,    15),
    stickyWindow:       threshold(a?.currentWindowMs,        14000, 25000),
    errorRate:          threshold(a?.errorRate != null ? a.errorRate * 100 : null, 5, 10),
  };

  const allStatuses  = Object.values(s);
  const lastRefresh  = health.dataUpdatedAt ? new Date(health.dataUpdatedAt).toLocaleTimeString() : null;
  const drift        = ledger?.drift ?? null;

  // ── Autopilot derived state ────────────────────────────────────────────────
  const ks         = (status?.killSwitches ?? []) as any[];
  const triggered  = ks.filter((k: any) => k.state !== "ENABLED");
  const switches   = ks;
  const evalState  = status?.globalEvaluator;
  const stratState = status?.strategy;
  const soState    = status?.selfOptimize;
  const leState    = status?.learningEngine;
  const incidents_ = (incidents?.incidents ?? []) as any[];
  const byType     = (incidents?.byType ?? {}) as Record<string, number>;
  const series     = (metrics?.series ?? {}) as Record<string, { value: number; timestamp: string }[]>;

  const confidenceEntries = Object.entries(leState?.confidenceMap ?? {})
    .map(([h, v]) => ({ hour: Number(h), confidence: v as number }))
    .sort((a, b) => a.hour - b.hour)
    .slice(-8);

  const apStatus: Status = apLoading ? "loading"
    : triggered.length > 0 ? "crit"
    : !status?.stable ? "warn"
    : "ok";

  return (
    <div className="space-y-6">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" />
            <h1 className="text-3xl font-bold tracking-tight">War Room</h1>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Real-time system health &amp; autopilot — refreshes every {POLL_MS / 1000}s
          </p>
        </div>
        {lastRefresh && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-secondary/30 px-3 py-1.5 rounded-xl border border-border/30">
            <Clock className="w-3.5 h-3.5" />
            Last update: {lastRefresh}
          </div>
        )}
      </div>

      {/* ── Overall infrastructure status ────────────────────────────────── */}
      <OverallStatus statuses={allStatuses} />

      {/* ── 4 infrastructure groups ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        <GroupCard title="Financial Integrity" group="integrity" icon={CheckCircle2}>
          <MetricRow label="DB Write Latency"  value={h?.latencyMs ?? "—"} unit=" ms" status={s.dbLatency}    sublabel="WARN >100ms · CRIT >300ms" />
          <MetricRow label="Pending Sagas"      value={queues?.pendingSagas ?? "—"}      status={s.pendingSagas}  sublabel="WARN >5 · CRIT >20" />
          <MetricRow label="Open Risk Alerts"   value={queues?.openFraudAlerts ?? "—"}   status={s.openAlerts}    sublabel="WARN ≥1 · CRIT ≥5" />
        </GroupCard>

        <GroupCard title="Outbox Health" group="outbox" icon={Activity}>
          <MetricRow label="Pending Queue Depth" value={o?.pending ?? "—"}    status={s.pendingDepth}   sublabel="WARN >50 · CRIT >500" />
          <MetricRow label="Dead-Letter Events"  value={o?.dead    ?? "—"}    status={s.deadLetters}    sublabel={o?.deadByClass
            ? Object.entries(o.deadByClass as Record<string,number>).filter(([,v]) => v > 0).map(([k,v]) => `${k}:${v}`).join(" · ") || "no DLQ entries"
            : "WARN ≥1 · CRIT ≥10"}
          />
          <MetricRow label="Processing Stuck"    value={o?.processing ?? "—"} status={s.processingStuck} sublabel="WARN ≥1 · restart worker to recover" />
        </GroupCard>

        <GroupCard title="Database Load" group="database" icon={AlertTriangle}>
          <MetricRow label="DB Status"           value={dbComp?.status ?? "—"}            status={s.dbStatus}           sublabel={`latency ${dbComp?.latencyMs ?? "—"}ms · SELECT 1 probe`} />
          <MetricRow label="Pending Settlements" value={queues?.pendingSettlements ?? "—"} status={s.pendingSettlements} sublabel="WARN >10 · CRIT >50" />
          <MetricRow label="Ledger Balance Drift" value={drift != null ? drift.toFixed(2) : "—"} unit=" XOF" status={s.balanceDrift} sublabel="Any non-zero = double-spend risk" />
        </GroupCard>

        <GroupCard title="Read Consistency" group="consistency" icon={RefreshCw}>
          <MetricRow label="Replica Lag"  value={r?.lagNull ? "NULL" : (r?.lagSec ?? "—")} unit={r?.lagNull ? "" : " s"} status={r?.lagNull ? "crit" : s.replicaLag} sublabel="WARN >5s · CRIT >15s · NULL=MAX window" />
          <MetricRow label="Sticky Window" value={a?.currentWindowMs != null ? (a.currentWindowMs / 1000).toFixed(1) : "—"} unit=" s" status={s.stickyWindow} sublabel={`min ${(a?.minMs ?? 0) / 1000}s · max ${(a?.maxMs ?? 0) / 1000}s · ${a?.activePins ?? 0} active pins`} />
          <MetricRow label="Error Rate"   value={a?.errorRate != null ? (a.errorRate * 100).toFixed(1) : "—"} unit="%" status={s.errorRate} sublabel={`p99 latency: ${a?.p99Ms ?? "—"}ms · WARN >5% · CRIT >10%`} />
        </GroupCard>

      </div>

      {/* ════════════════════════════════════════════════════════════════════
          AUTOPILOT COMMAND CENTER
          ════════════════════════════════════════════════════════════════════ */}
      <div className="flex items-center gap-3 pt-2">
        <Bot className="w-5 h-5 text-emerald-400" />
        <h2 className="text-lg font-bold tracking-tight">Autopilot Command Center</h2>
        <span className={cn(
          "px-2.5 py-0.5 rounded-full text-xs font-bold font-mono border",
          apStatus === "loading" ? "bg-muted/30 border-border/30 text-muted-foreground"
          : apStatus === "crit"  ? "bg-red-500/15 border-red-500/30 text-red-300"
          : apStatus === "warn"  ? "bg-amber-500/15 border-amber-500/30 text-amber-300"
          : "bg-emerald-500/15 border-emerald-500/30 text-emerald-300",
        )}>
          {apStatus === "loading" ? "connecting…"
          : apStatus === "crit"  ? `${triggered.length} kill switch${triggered.length !== 1 ? "es" : ""} triggered`
          : apStatus === "warn"  ? "active incidents"
          : "stable"}
        </span>
      </div>

      {/* ── Command Status row ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">

        {/* Mode */}
        <div className="rounded-2xl border border-border/30 bg-card/60 backdrop-blur-xl p-4 flex flex-col gap-2 shadow-xl shadow-black/10">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Strategy Mode</span>
          <div className="flex items-center gap-2 mt-1">
            <ModeBadge mode={status?.strategyMode} />
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            dwell {stratState?.cyclesInMode ?? "—"} / {stratState?.dwellRequired ?? "—"} cycles
          </span>
        </div>

        {/* Batch size */}
        <div className="rounded-2xl border border-border/30 bg-card/60 backdrop-blur-xl p-4 flex flex-col gap-2 shadow-xl shadow-black/10">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Batch Size</span>
          <span className={cn("text-2xl font-mono font-bold tabular-nums",
            (status?.batchSize ?? 50) < 25 ? "text-amber-400" : "text-emerald-400"
          )}>
            {status?.batchSize ?? "—"}
          </span>
          <span className="text-xs text-muted-foreground font-mono">max 50 · min 5</span>
        </div>

        {/* Stable / cycle */}
        <div className="rounded-2xl border border-border/30 bg-card/60 backdrop-blur-xl p-4 flex flex-col gap-2 shadow-xl shadow-black/10">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">System Stability</span>
          <div className="flex items-center gap-2 mt-1">
            <span className={cn("w-2.5 h-2.5 rounded-full shadow-md flex-shrink-0",
              status == null ? "bg-muted" : status.stable ? "bg-emerald-500 shadow-emerald-500/50" : "bg-amber-400 shadow-amber-400/50 animate-pulse"
            )} />
            <span className={cn("text-sm font-bold font-mono",
              status == null ? "text-muted-foreground" : status.stable ? "text-emerald-400" : "text-amber-400"
            )}>
              {status == null ? "—" : status.stable ? "STABLE" : "INCIDENTS"}
            </span>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            cycle #{evalState?.cycleCount ?? "—"} · window {status?.stableWindow ?? "15 s"}
          </span>
        </div>

        {/* Autopilot */}
        <div className="rounded-2xl border border-border/30 bg-card/60 backdrop-blur-xl p-4 flex flex-col gap-2 shadow-xl shadow-black/10">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Autopilot</span>
          <div className="flex items-center gap-2 mt-1">
            <span className={cn("w-2.5 h-2.5 rounded-full shadow-md flex-shrink-0",
              status?.autopilot?.running ? "bg-emerald-500 shadow-emerald-500/50" : "bg-muted"
            )} />
            <span className={cn("text-sm font-bold font-mono",
              status?.autopilot?.running ? "text-emerald-400" : "text-muted-foreground"
            )}>
              {status?.autopilot?.running ? "RUNNING" : "STOPPED"}
            </span>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            poll {status?.autopilot?.pollMs ? `${status.autopilot.pollMs / 1000}s` : "—"} · {status?.autopilot?.rules?.length ?? 0} rules
          </span>
        </div>

      </div>

      {/* ── Kill switches + Suppressions ────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        <GroupCard title="Kill Switches" group="autopilot" icon={Shield}>
          {switches.length === 0
            ? <p className="text-xs text-muted-foreground px-4 py-2">Loading…</p>
            : switches.map((ks: any) => (
                <KillSwitchRow key={ks.name} name={ks.name} state={ks.state} reason={ks.reason} />
              ))
          }
        </GroupCard>

        <GroupCard title="Engine Intelligence" group="engine" icon={Cpu}>
          <div className="px-1 flex flex-col gap-3">

            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1.5">Active Suppressions</p>
              <SuppressionList suppressions={evalState?.suppressions ?? {}} />
            </div>

            <div className="border-t border-border/20 pt-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">Learning Confidence (last 8 h)</p>
              {confidenceEntries.length === 0
                ? <span className="text-xs text-muted-foreground font-mono">accumulating…</span>
                : confidenceEntries.map(({ hour, confidence }) => (
                    <div key={hour} className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-mono text-muted-foreground w-8 flex-shrink-0">{String(hour).padStart(2,"0")}:00</span>
                      <ConfidenceBar value={confidence} />
                    </div>
                  ))
              }
            </div>

            <div className="border-t border-border/20 pt-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">Self-Optimize Averages</p>
              <div className="flex flex-col gap-1">
                {Object.entries(soState?.averages ?? {}).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs font-mono">
                    <span className="text-muted-foreground">{k.replace(/_/g," ")}</span>
                    <span className="text-foreground tabular-nums">{(v as number).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </GroupCard>

      </div>

      {/* ── Metrics stream ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-teal-400" />
        <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Metrics Stream · last 20 samples per key</h3>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {(["db_latency", "outbox_pending", "dlq_rate", "balance_drift", "replica_lag"] as const).map(key => (
          <SparklineCard key={key} metricKey={key} points={series[key] ?? []} />
        ))}
      </div>

      {/* ── Incident feed ────────────────────────────────────────────────────── */}
      <GroupCard title={`Incident Feed · ${incidents?.total ?? "…"} total · last ${incidents_.length} shown`} group="incidents" icon={Zap}>
        {/* Type tally bar */}
        {Object.keys(byType).length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pb-2 border-b border-border/20">
            {Object.entries(byType)
              .sort(([,a],[,b]) => b - a)
              .map(([type, count]) => (
                <span key={type} className={cn("px-2 py-0.5 rounded-md text-xs font-mono font-bold", typeColor(type))}>
                  {type.replace(/_/g," ")} ×{count}
                </span>
              ))
            }
          </div>
        )}

        {/* Scrollable list */}
        <div className="max-h-72 overflow-y-auto scrollbar-thin scrollbar-thumb-border/40 scrollbar-track-transparent">
          {incidents_.length === 0
            ? <p className="text-xs text-muted-foreground px-4 py-4 text-center">
                {apLoading ? "Loading…" : "No incidents recorded yet"}
              </p>
            : incidents_.map((inc: any) => (
                <IncidentRow
                  key={inc.id}
                  type={inc.type}
                  action={inc.action}
                  result={inc.result}
                  createdAt={inc.createdAt}
                />
              ))
          }
        </div>
      </GroupCard>

      {/* ── Last decision ────────────────────────────────────────────────────── */}
      {status?.lastIncident && (
        <div className="rounded-2xl border border-border/30 bg-card/60 backdrop-blur-xl px-5 py-4 flex flex-col gap-1.5 shadow-xl shadow-black/10">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Last Autopilot Decision</span>
          <div className="flex flex-wrap items-center gap-3 mt-1">
            <span className={cn("px-2 py-0.5 rounded-md text-xs font-mono font-bold", typeColor(status.lastIncident.type))}>
              {status.lastIncident.type.replace(/_/g," ")}
            </span>
            <span className="text-sm font-mono text-foreground/80">{status.lastIncident.action}</span>
            <span className="text-xs text-muted-foreground">→</span>
            <span className="text-sm font-mono text-foreground/60 flex-1 min-w-0 truncate">{status.lastIncident.result}</span>
            <span className="text-xs font-mono text-muted-foreground flex-shrink-0">
              {new Date(status.lastIncident.createdAt).toLocaleTimeString()}
            </span>
          </div>
        </div>
      )}

    </div>
  );
}
