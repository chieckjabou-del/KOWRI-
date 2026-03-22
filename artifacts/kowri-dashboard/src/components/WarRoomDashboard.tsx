import { useQuery } from "@tanstack/react-query";
import { useRef, useEffect, useState } from "react";
import {
  LineChart, Line, ResponsiveContainer, Tooltip,
} from "recharts";
import {
  Activity, Lock, AlertTriangle, CheckCircle2, XCircle,
  RefreshCw, Zap, Shield, Bot, DollarSign, BarChart3,
  Layers, Clock, TrendingUp, TrendingDown,
} from "lucide-react";

// ─────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const api  = (path: string) =>
  fetch(`${BASE}${path}`).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const GREEN  = "#10B981";
const AMBER  = "#F59E0B";
const RED    = "#EF4444";
const BLUE   = "#3B82F6";
const DIMMED = "#374151";

// ─────────────────────────────────────────────────────────
//  Hooks
// ─────────────────────────────────────────────────────────

function useLive()     { return useQuery({ queryKey: ["wr-live"],     queryFn: () => api("/api/warroom/live"),          refetchInterval: 5_000,  staleTime: 5_000  }); }
function useMetrics()  { return useQuery({ queryKey: ["wr-metrics"],  queryFn: () => api("/api/warroom/metrics"),       refetchInterval: 10_000, staleTime: 5_000  }); }
function useStatus()   { return useQuery({ queryKey: ["wr-status"],   queryFn: () => api("/api/warroom/status"),        refetchInterval: 5_000,  staleTime: 5_000  }); }
function useSnapshot() { return useQuery({ queryKey: ["wr-snapshot"], queryFn: () => api("/api/warroom/snapshot"),      refetchInterval: 10_000, staleTime: 5_000  }); }
function useImpact()   { return useQuery({ queryKey: ["wr-impact"],   queryFn: () => api("/api/warroom/impact"),        refetchInterval: 30_000, staleTime: 10_000 }); }
function useSysSnap()  { return useQuery({ queryKey: ["wr-syssnap"],  queryFn: () => api("/api/system/snapshot"),       refetchInterval: 10_000, staleTime: 5_000  }); }

// ─────────────────────────────────────────────────────────
//  Palette helpers
// ─────────────────────────────────────────────────────────

function trustColor(v: number) {
  if (v >= 95) return GREEN;
  if (v >= 70) return AMBER;
  return RED;
}

function modeColor(mode: string) {
  if (mode === "LATENCY_FIRST")    return AMBER;
  if (mode === "THROUGHPUT_FIRST") return GREEN;
  return BLUE; // BALANCED
}

function confidenceColor(lvl: string) {
  if (lvl === "HIGH")   return GREEN;
  if (lvl === "MEDIUM") return AMBER;
  return RED;
}

function riskColor(risk: string) {
  if (risk === "NONE")   return GREEN;
  if (risk === "LOW")    return BLUE;
  if (risk === "MEDIUM") return AMBER;
  return RED;
}

function pressureColor(p: number) {
  if (p >= 100) return GREEN;
  if (p >= 70)  return AMBER;
  return RED;
}

function staleWarning(updatedAt: number | undefined, maxMs = 15_000) {
  if (!updatedAt) return false;
  return Date.now() - updatedAt > maxMs;
}

// ─────────────────────────────────────────────────────────
//  Primitives
// ─────────────────────────────────────────────────────────

function Card({
  children, title, icon: Icon, stale = false, error = false,
  accent = DIMMED,
}: {
  children: React.ReactNode; title: string; icon: React.ElementType;
  stale?: boolean; error?: boolean; accent?: string;
}) {
  const border = error ? "border-red-500/60" : stale ? "border-amber-500/50" : "border-white/8";
  return (
    <div
      className="rounded-2xl flex flex-col gap-4 p-5 transition-all duration-200 hover:shadow-lg"
      style={{
        background: "#111827",
        border: `1px solid`,
        borderColor: error ? "#EF4444" : stale ? "#F59E0B" : "rgba(255,255,255,0.08)",
        boxShadow: `0 0 0 0 transparent`,
      }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = `0 0 16px 2px ${accent}22`)}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = "0 0 0 0 transparent")}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} style={{ color: accent }} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "#6B7280" }}>
            {title}
          </span>
        </div>
        {stale  && <span className="text-[10px] font-mono" style={{ color: AMBER }}>⚠ stale</span>}
        {error  && <span className="text-[10px] font-mono" style={{ color: RED }}>✕ connection lost</span>}
      </div>
      {children}
    </div>
  );
}

function Dot({ on, size = 10 }: { on: boolean; size?: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size, height: size,
        borderRadius: "50%",
        background: on ? GREEN : RED,
        boxShadow: on ? `0 0 6px ${GREEN}` : `0 0 6px ${RED}`,
        flexShrink: 0,
      }}
    />
  );
}

function Badge({
  children, color = GREEN,
}: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold font-mono"
      style={{
        background: `${color}22`,
        color,
        border: `1px solid ${color}55`,
      }}
    >
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────
//  Section 1 — Trust Score (Circular Gauge)
// ─────────────────────────────────────────────────────────

function TrustScoreSection({ live }: { live: ReturnType<typeof useLive> }) {
  const ts = live.data?.trustScore;
  const value = ts?.value ?? 0;
  const signals = ts?.signals ?? {};
  const color = trustColor(value);

  // SVG gauge
  const R = 54;
  const circumference = 2 * Math.PI * R;
  const offset = circumference * (1 - value / 100);

  const signalList = [
    { key: "metricsHealthy",  label: "Metrics Healthy"  },
    { key: "dbWriteable",     label: "DB Writeable"     },
    { key: "cycleRunning",    label: "Cycle Running"    },
    { key: "stateConsistent", label: "State Consistent" },
  ] as const;

  return (
    <Card
      title="Trust Score"
      icon={Shield}
      stale={staleWarning(live.dataUpdatedAt)}
      error={live.isError}
      accent={color}
    >
      <div className="flex flex-col items-center gap-4">
        <svg width="132" height="132" viewBox="0 0 132 132">
          <circle cx="66" cy="66" r={R} fill="none" stroke="#1F2937" strokeWidth="12" />
          <circle
            cx="66" cy="66" r={R}
            fill="none"
            stroke={color}
            strokeWidth="12"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 66 66)"
            style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.4s" }}
          />
          <text x="66" y="62" textAnchor="middle" fontSize="28" fontWeight="700"
            fontFamily="monospace" fill={color}>
            {value}
          </text>
          <text x="66" y="80" textAnchor="middle" fontSize="10"
            fontFamily="sans-serif" fill="#6B7280">
            {ts?.status ?? "—"}
          </text>
        </svg>

        <div className="w-full grid grid-cols-2 gap-2">
          {signalList.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-2">
              <Dot on={!!(signals as any)[key]} size={8} />
              <span className="text-xs" style={{ color: "#9CA3AF" }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
//  Section 2 — Heartbeat
// ─────────────────────────────────────────────────────────

function HeartbeatSection({ live }: { live: ReturnType<typeof useLive> }) {
  const hb = live.data?.heartbeat;
  const status = hb?.status ?? "—";
  const mode   = hb?.currentMode ?? "BALANCED";
  const ageMs  = hb?.cycleAgeMs ?? null;
  const cycles = hb?.cyclesSinceLastIncident;

  const statusColor = status === "active" ? GREEN : status === "stale" ? AMBER : RED;
  const statusLabel = status === "active" ? "ALIVE" : status === "stale" ? "STALLED" : "DEAD";

  return (
    <Card
      title="Heartbeat"
      icon={Activity}
      stale={staleWarning(live.dataUpdatedAt)}
      error={live.isError}
      accent={statusColor}
    >
      <div className="flex flex-col gap-4 items-center">
        <span
          className="text-4xl font-black font-mono tracking-widest"
          style={{ color: statusColor, textShadow: `0 0 20px ${statusColor}88` }}
        >
          {statusLabel}
        </span>

        <div className="text-center">
          <span className="text-xs" style={{ color: "#6B7280" }}>Last cycle </span>
          <span className="font-mono text-sm" style={{ color: "#E5E7EB" }}>
            {ageMs != null ? `${ageMs.toLocaleString()}ms ago` : "—"}
          </span>
        </div>

        <div className="flex flex-col items-center gap-2 w-full">
          <Badge color={modeColor(mode)}>{mode.replace("_", " ")}</Badge>
          <div className="text-xs" style={{ color: "#6B7280" }}>
            Cycles since last incident:{" "}
            <span className="font-mono" style={{ color: GREEN }}>
              {cycles ?? "—"}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
//  Section 3 — AI Decision Panel
// ─────────────────────────────────────────────────────────

function AIDecisionSection({ live, status }: {
  live: ReturnType<typeof useLive>; status: ReturnType<typeof useStatus>;
}) {
  const ai   = live.data?.aiDecisionPanel;
  const dec  = status.data?.strategy?.lastDecision;
  const conf = ai?.confidenceLevel ?? "—";
  const cColor = confidenceColor(conf);

  return (
    <Card
      title="AI Decision Panel"
      icon={Bot}
      stale={staleWarning(live.dataUpdatedAt)}
      error={live.isError}
      accent={BLUE}
    >
      <div className="flex flex-col gap-3">
        <div>
          <span className="text-xs font-semibold" style={{ color: "#9CA3AF" }}>Layer</span>
          <p className="font-bold text-sm mt-0.5" style={{ color: "#E5E7EB" }}>
            {dec?.decided_at ? "strategy_engine" : "global_evaluator"}
          </p>
        </div>

        <div>
          <span className="text-xs font-semibold" style={{ color: "#9CA3AF" }}>Action</span>
          <p className="font-mono text-xs mt-0.5 break-all" style={{ color: "#60A5FA" }}>
            {dec?.raw_desired_mode ?? ai?.currentMode ?? "—"}
          </p>
        </div>

        <div>
          <span className="text-xs font-semibold" style={{ color: "#9CA3AF" }}>Reason</span>
          <p className="text-xs italic mt-0.5" style={{ color: "#D1D5DB" }}>
            {ai?.reason ?? dec?.reason ?? "—"}
          </p>
        </div>

        <div>
          <span className="text-xs font-semibold" style={{ color: "#9CA3AF" }}>Expected Impact</span>
          <p className="text-xs mt-0.5" style={{ color: "#D1D5DB" }}>
            {ai?.expectedImpact ?? "—"}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Badge color={cColor}>{conf} CONFIDENCE</Badge>
          {ai?.humanReviewRequired && (
            <div className="flex items-center gap-1">
              <AlertTriangle size={12} style={{ color: RED }} />
              <span className="text-xs font-bold" style={{ color: RED }}>REVIEW REQUIRED</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
//  Section 4 — Money Mode
// ─────────────────────────────────────────────────────────

function MoneyModeSection({ live }: { live: ReturnType<typeof useLive> }) {
  const mm = live.data?.moneyMode;
  const pressure = mm?.throughputPressure ?? 0;
  const risk     = mm?.revenueRiskLevel ?? "NONE";
  const ks       = (mm?.activeKillSwitches ?? []) as { name: string }[];
  const pColor   = pressureColor(pressure);
  const rColor   = riskColor(risk);

  return (
    <Card
      title="Money Mode"
      icon={DollarSign}
      stale={staleWarning(live.dataUpdatedAt)}
      error={live.isError}
      accent={pColor}
    >
      <div className="flex flex-col gap-4">
        {/* Throughput Pressure bar */}
        <div>
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-xs" style={{ color: "#9CA3AF" }}>Throughput Pressure</span>
            <span className="font-mono font-bold text-sm" style={{ color: pColor }}>
              {pressure}%
            </span>
          </div>
          <div className="w-full h-3 rounded-full overflow-hidden" style={{ background: "#1F2937" }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${Math.min(pressure, 100)}%`, background: pColor }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: "#9CA3AF" }}>Revenue Risk:</span>
          <Badge color={rColor}>{risk}</Badge>
        </div>

        <div>
          <span className="text-xs mb-2 block" style={{ color: "#9CA3AF" }}>Active Kill Switches</span>
          <div className="flex flex-wrap gap-1.5">
            {ks.length === 0
              ? <span className="text-xs font-mono" style={{ color: GREEN }}>None Active</span>
              : ks.map(k => (
                  <Badge key={k.name} color={RED}>{k.name.replace(/_/g, " ")}</Badge>
                ))
            }
          </div>
        </div>

        <div className="text-xs" style={{ color: "#9CA3AF" }}>
          ETA: <span style={{ color: "#E5E7EB" }}>{mm?.recoveryEta ?? "—"}</span>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
//  Section 5 — Metrics Sparklines
// ─────────────────────────────────────────────────────────

const SPARKLINE_META: Record<string, { label: string; unit: string; warnAt: number }> = {
  db_latency:     { label: "DB Latency",     unit: "ms",  warnAt: 100 },
  outbox_pending: { label: "Outbox Pending", unit: "",    warnAt: 50  },
  replica_lag:    { label: "Replica Lag",    unit: "s",   warnAt: 5   },
  dlq_rate:       { label: "DLQ Rate",       unit: "",    warnAt: 1   },
};

// batch_size is not in the metrics series — we track it locally from live data
function MetricSparkline({
  metricKey, series, batchSizeHistory,
}: {
  metricKey: string;
  series: Record<string, { value: number; timestamp: string }[]>;
  batchSizeHistory: number[];
}) {
  const meta = SPARKLINE_META[metricKey];
  const pts = metricKey === "batch_size"
    ? batchSizeHistory.map((v, i) => ({ v, i }))
    : (series[metricKey] ?? []).map((p, i) => ({ v: p.value, i }));

  const current = pts.length > 0 ? pts[pts.length - 1].v : null;
  const isElevated = current != null && meta && current >= meta.warnAt;
  const lineColor = isElevated ? RED : GREEN;

  const label = metricKey === "batch_size" ? "Batch Size" : meta?.label ?? metricKey;
  const unit  = metricKey === "batch_size" ? "" : meta?.unit ?? "";

  return (
    <div
      className="flex flex-col gap-2 p-3 rounded-xl"
      style={{
        background: "#0D1117",
        border: `1px solid ${isElevated ? RED + "44" : GREEN + "22"}`,
      }}
    >
      <div className="flex justify-between items-start">
        <span className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: "#6B7280" }}>
          {label}
        </span>
        {isElevated
          ? <TrendingUp size={11} style={{ color: RED }} />
          : <TrendingDown size={11} style={{ color: GREEN }} />
        }
      </div>
      <span className="font-mono font-bold text-xl" style={{ color: lineColor }}>
        {current != null ? `${Number(current).toFixed(1)}${unit}` : "—"}
      </span>
      <div style={{ height: 44 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={pts}>
            <Line
              type="monotone"
              dataKey="v"
              stroke={lineColor}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Tooltip
              content={() => null}
              cursor={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function MetricsSparklinesSection({
  metrics, live,
}: {
  metrics: ReturnType<typeof useMetrics>;
  live: ReturnType<typeof useLive>;
}) {
  const series = metrics.data?.series ?? {};

  // Keep a rolling 20-point history for batch_size from live polling
  const batchRef = useRef<number[]>([]);
  useEffect(() => {
    const v = live.data?.batchSize;
    if (v == null) return;
    batchRef.current = [...batchRef.current.slice(-19), v];
  }, [live.data?.batchSize]);

  const keys = ["db_latency", "outbox_pending", "replica_lag", "batch_size", "dlq_rate"];

  return (
    <Card
      title="Metric Sparklines"
      icon={BarChart3}
      stale={staleWarning(metrics.dataUpdatedAt)}
      error={metrics.isError}
      accent={BLUE}
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
        {keys.map(k => (
          <MetricSparkline
            key={k}
            metricKey={k}
            series={series}
            batchSizeHistory={batchRef.current}
          />
        ))}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
//  Section 6 — Impact Counters
// ─────────────────────────────────────────────────────────

function ImpactCounter({ label, value }: { label: string; value: string | number }) {
  const isNum = typeof value === "number";
  return (
    <div className="flex flex-col items-center gap-1 py-3 overflow-hidden">
      {isNum ? (
        <span className="font-mono font-black text-3xl" style={{ color: "#E5E7EB" }}>
          {(value as number).toLocaleString()}
        </span>
      ) : (
        <span
          className="font-mono text-xs text-center leading-tight"
          style={{ color: "#E5E7EB", wordBreak: "break-word" }}
        >
          {value}
        </span>
      )}
      <span className="text-[10px] uppercase tracking-widest text-center" style={{ color: "#6B7280" }}>
        {label}
      </span>
    </div>
  );
}

function ImpactSection({ impact }: { impact: ReturnType<typeof useImpact> }) {
  const d = impact.data;
  return (
    <Card
      title="Impact Counters"
      icon={Zap}
      stale={staleWarning(impact.dataUpdatedAt, 45_000)}
      error={impact.isError}
      accent={GREEN}
    >
      <div className="grid grid-cols-2 gap-2 divide-y divide-white/5">
        <ImpactCounter label="Incidents Auto Resolved"        value={d?.incidentsAutoResolved ?? "—"} />
        <ImpactCounter label="Manual Interventions Required"  value={d?.manualInterventionsRequired ?? "—"} />
        <ImpactCounter label="Transactions Protected"         value={d?.estimatedTransactionsProtected ?? "—"} />
        <ImpactCounter label="Uptime Status"                  value={d?.uptimeSinceLastManualIntervention ?? "—"} />
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
//  Section 7 — Kill Switches
// ─────────────────────────────────────────────────────────

const KS_ORDER = [
  "outbound_transfers", "settlements", "batch_writes",
  "saga_creation", "outbox_dispatch", "replica_reads", "all",
];

function KillSwitchRow({ name, state, reason }: { name: string; state: string; reason?: string }) {
  const isEnabled    = state === "ENABLED";
  const isTriggered  = state === "TRIGGERED";
  const isForcedOff  = state === "FORCED_OFF";

  const dotColor = isEnabled ? GREEN : isTriggered ? AMBER : RED;
  const textColor = isEnabled ? "#10B981" : isTriggered ? "#F59E0B" : "#EF4444";

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-white/4 transition-colors">
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: dotColor,
            boxShadow: isTriggered ? `0 0 8px ${AMBER}` : undefined,
            animation: isTriggered ? "pulse 1.5s infinite" : undefined,
          }}
        />
        <span className="text-xs font-mono truncate" style={{ color: "#D1D5DB" }}>
          {name.replace(/_/g, " ")}
        </span>
        {isForcedOff && <Lock size={10} style={{ color: RED, flexShrink: 0 }} />}
      </div>
      <span className="text-[10px] font-bold font-mono flex-shrink-0 ml-3" style={{ color: textColor }}>
        {state}
      </span>
    </div>
  );
}

function KillSwitchSection({ status }: { status: ReturnType<typeof useStatus> }) {
  const ks = (status.data?.killSwitches ?? []) as { name: string; state: string; reason?: string }[];
  const byName = Object.fromEntries(ks.map(k => [k.name, k]));

  return (
    <Card
      title="Kill Switches"
      icon={Shield}
      stale={staleWarning(status.dataUpdatedAt)}
      error={status.isError}
      accent={DIMMED}
    >
      <div className="flex flex-col gap-0.5">
        {KS_ORDER.map(name => {
          const sw = byName[name];
          return sw
            ? <KillSwitchRow key={name} {...sw} />
            : <KillSwitchRow key={name} name={name} state="ENABLED" />;
        })}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
//  Section 8 — Recent Incidents
// ─────────────────────────────────────────────────────────

const INC_COLORS: Record<string, string> = {
  latency_spike:     AMBER,
  stuck_worker:      RED,
  latency_ok:        GREEN,
  global_evaluator:  BLUE,
  strategy_engine:   "#8B5CF6",
  healing:           "#F97316",
  metrics_collector: "#14B8A6",
  reconciliation:    "#EC4899",
};

function incidentColor(type: string) {
  return INC_COLORS[type] ?? "#6B7280";
}

function RecentIncidentsSection({ snapshot }: { snapshot: ReturnType<typeof useSnapshot> }) {
  const incidents = (snapshot.data?.incidents?.incidents ?? []) as {
    type: string; action: string; result: string; createdAt: string;
  }[];
  const top10 = incidents.slice(0, 10);

  return (
    <Card
      title="Recent Incidents"
      icon={AlertTriangle}
      stale={staleWarning(snapshot.dataUpdatedAt)}
      error={snapshot.isError}
      accent="#EF4444"
    >
      <div className="flex flex-col gap-0">
        {top10.length === 0 && (
          <div className="text-xs py-4 text-center" style={{ color: "#6B7280" }}>
            No incidents recorded
          </div>
        )}
        {top10.map((inc, i) => {
          const t = new Date(inc.createdAt);
          const ts = `${t.getHours().toString().padStart(2,"0")}:${t.getMinutes().toString().padStart(2,"0")}:${t.getSeconds().toString().padStart(2,"0")}`;
          const color = incidentColor(inc.type);
          return (
            <div
              key={i}
              className="flex items-start gap-3 py-2.5 border-b border-white/5 last:border-0"
            >
              <span className="font-mono text-[10px] flex-shrink-0 pt-0.5" style={{ color: "#6B7280" }}>
                {ts}
              </span>
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded flex-shrink-0"
                style={{ background: `${color}22`, color }}
              >
                {inc.type.replace(/_/g, " ")}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-mono truncate" style={{ color: "#E5E7EB" }}>
                  {inc.action}
                </p>
                <p className="text-[10px] truncate" style={{ color: "#9CA3AF" }}>
                  {inc.result}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
//  Section 9 — Batch Controller
// ─────────────────────────────────────────────────────────

function BatchControllerSection({ live }: { live: ReturnType<typeof useLive> }) {
  const bc = live.data?.batchController;
  const pressure = bc?.batchPressure ?? 0;
  const pColor = pressureColor(pressure);

  return (
    <Card
      title="Batch Controller"
      icon={Layers}
      stale={staleWarning(live.dataUpdatedAt)}
      error={live.isError}
      accent={pColor}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="text-[10px] uppercase tracking-widest" style={{ color: "#6B7280" }}>Locked By</span>
          <p className="font-mono text-sm mt-1" style={{ color: bc?.lockedBy ? AMBER : GREEN }}>
            {bc?.lockedBy ?? "none"}
          </p>
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-widest" style={{ color: "#6B7280" }}>Skips This Cycle</span>
          <p className="font-mono text-sm mt-1" style={{ color: (bc?.skipsThisCycle ?? 0) > 0 ? AMBER : GREEN }}>
            {bc?.skipsThisCycle ?? 0}
          </p>
        </div>
        <div className="col-span-2">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: "#6B7280" }}>Batch Size</span>
          <div className="flex items-center gap-2 mt-1">
            <span className="font-mono text-sm" style={{ color: "#9CA3AF" }}>
              {bc?.batchBefore ?? "—"}
            </span>
            <span style={{ color: "#6B7280" }}>→</span>
            <span className="font-mono text-sm font-bold" style={{ color: "#E5E7EB" }}>
              {bc?.batchAfter ?? live.data?.batchSize ?? "—"}
            </span>
          </div>
        </div>
        <div className="col-span-2">
          <div className="flex justify-between mb-1">
            <span className="text-[10px] uppercase tracking-widest" style={{ color: "#6B7280" }}>Pressure</span>
            <span className="font-mono text-xs font-bold" style={{ color: pColor }}>{pressure}%</span>
          </div>
          <div className="w-full h-2.5 rounded-full overflow-hidden" style={{ background: "#1F2937" }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${Math.min(pressure, 100)}%`, background: pColor }}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────
//  Header
// ─────────────────────────────────────────────────────────

function Header({
  live, isFetching,
}: {
  live: ReturnType<typeof useLive>; isFetching: boolean;
}) {
  const updatedAt = live.data?.updatedAt;
  const ts = updatedAt ? new Date(updatedAt).toLocaleTimeString() : null;

  const status = live.data?.heartbeat?.status ?? null;
  const dotColor = status === "active" ? GREEN : status === "stale" ? AMBER : RED;

  return (
    <div
      className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pb-5 mb-1"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span
            style={{
              display: "inline-block", width: 12, height: 12, borderRadius: "50%",
              background: dotColor,
              boxShadow: `0 0 10px ${dotColor}`,
              animation: status === "active" ? "pulse 2s infinite" : undefined,
              flexShrink: 0,
            }}
          />
          <h1
            className="text-xl font-black tracking-[0.15em] font-mono"
            style={{ color: "#E5E7EB" }}
          >
            KOWRI AUTOPILOT
          </h1>
        </div>
        {isFetching && (
          <RefreshCw
            size={14}
            style={{ color: "#6B7280", animation: "spin 1s linear infinite" }}
          />
        )}
      </div>

      {ts && (
        <div className="flex items-center gap-1.5 text-xs font-mono" style={{ color: "#6B7280" }}>
          <Clock size={11} />
          Last updated: <span style={{ color: "#9CA3AF" }}>{ts}</span>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
//  Main export
// ─────────────────────────────────────────────────────────

export default function WarRoomDashboard() {
  const live     = useLive();
  const metrics  = useMetrics();
  const status   = useStatus();
  const snapshot = useSnapshot();
  const impact   = useImpact();

  const isFetching = live.isFetching || metrics.isFetching || status.isFetching
    || snapshot.isFetching || impact.isFetching;

  return (
    <div
      className="min-h-screen w-full"
      style={{ background: "#0A0A0F", padding: "24px" }}
    >
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
        @keyframes spin  { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>

      <Header live={live} isFetching={isFetching} />

      {/* ── Row 1: Trust | Heartbeat | AI Panel ─────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 mb-5">
        <TrustScoreSection live={live} />
        <HeartbeatSection  live={live} />
        <AIDecisionSection live={live} status={status} />
      </div>

      {/* ── Row 2: Money Mode | Sparklines | Impact ──────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 mb-5">
        <MoneyModeSection       live={live} />
        <MetricsSparklinesSection metrics={metrics} live={live} />
        <ImpactSection          impact={impact} />
      </div>

      {/* ── Row 3: Kill Switches | Batch Controller | Incidents ───── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        <KillSwitchSection     status={status} />
        <BatchControllerSection live={live} />
        <RecentIncidentsSection snapshot={snapshot} />
      </div>
    </div>
  );
}
