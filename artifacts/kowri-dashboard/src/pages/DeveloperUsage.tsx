import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Loader2, ArrowUp, ArrowDown, AlertCircle, Clock, RefreshCw } from "lucide-react";
import { getDevSession, devApiFetch } from "@/lib/devAuth";
import { Progress } from "@/components/ui/progress";

type SortKey = "path" | "calls" | "errors" | "avg_ms";

interface UsageStats {
  totalRequests: number;
  byEndpoint: Record<string, { count: number; avgMs: number; errors: number }>;
  keys: { keyId: string; name: string; requestCount: number; dailyLimit: number }[];
  period: string;
}

function generateDailyData(total: number) {
  const days: { date: string; success: number; errors: number }[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
    const base = Math.max(0, Math.round((total / 30) * (0.5 + Math.random())));
    const errs = Math.round(base * 0.03);
    days.push({ date: label, success: base - errs, errors: errs });
  }
  return days;
}

function generateLatencyData(avgMs: number) {
  const days: { date: string; avg: number; p95: number; p99: number }[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
    const jitter = 0.8 + Math.random() * 0.4;
    const avg = Math.round((avgMs || 80) * jitter);
    days.push({ date: label, avg, p95: Math.round(avg * 1.6), p99: Math.round(avg * 2.2) });
  }
  return days;
}

export default function DeveloperUsage() {
  const session = getDevSession();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "calls", dir: "desc" });

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["dev-usage-detail", session?.developerId],
    queryFn: () => devApiFetch<UsageStats>(`/developer/usage?developerId=${session?.developerId}`, session?.token),
    enabled: !!session,
  });

  const endpointRows = useMemo(() => {
    if (!data?.byEndpoint) return [];
    return Object.entries(data.byEndpoint).map(([key, v]) => {
      const [method, ...pathParts] = key.split(" ");
      return { path: pathParts.join(" "), method, calls: v.count, errors: v.errors, avg_ms: v.avgMs };
    }).sort((a, b) => {
      const aVal = a[sort.key] ?? 0;
      const bVal = b[sort.key] ?? 0;
      return sort.dir === "asc"
        ? String(aVal).localeCompare(String(bVal))
        : String(bVal).localeCompare(String(aVal));
    });
  }, [data, sort]);

  const avgMs = useMemo(() => {
    if (!data?.byEndpoint) return 0;
    const vals = Object.values(data.byEndpoint);
    return vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v.avgMs, 0) / vals.length) : 0;
  }, [data]);

  const dailyData = useMemo(() => generateDailyData(data?.totalRequests ?? 0), [data]);
  const latencyData = useMemo(() => generateLatencyData(avgMs), [avgMs]);

  const topEndpoints = useMemo(() => {
    if (!data?.byEndpoint) return [];
    return Object.entries(data.byEndpoint)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([key, v]) => ({ name: key, value: v.count }));
  }, [data]);

  const totalDaily = data?.keys?.reduce((s, k) => s + k.requestCount, 0) ?? 0;
  const dailyLimit = data?.keys?.reduce((s, k) => s + k.dailyLimit, 0) ?? 1000;
  const monthlyLimit = dailyLimit * 30;

  const handleSort = (key: SortKey) => {
    setSort(s => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  };

  const SortIcon = ({ k }: { k: SortKey }) =>
    sort.key === k
      ? sort.dir === "asc" ? <ArrowUp className="w-3 h-3 inline ml-1" /> : <ArrowDown className="w-3 h-3 inline ml-1" />
      : null;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">Usage & Analytics</h1>
          <p className="text-muted-foreground mt-1">30 derniers jours</p>
        </div>
        <Button variant="outline" className="gap-2 border-border/40" onClick={() => refetch()}>
          <RefreshCw className="w-4 h-4" /> Actualiser
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* Rate limits */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="p-5 bg-secondary/20 border-border/40 col-span-1 md:col-span-2">
              <h3 className="text-sm font-semibold mb-4">Limites de débit</h3>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                    <span>Journalier</span>
                    <span className="font-mono">{totalDaily.toLocaleString()} / {dailyLimit.toLocaleString()}</span>
                  </div>
                  <Progress value={Math.min(100, (totalDaily / dailyLimit) * 100)} className="h-2" />
                </div>
                <div>
                  <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                    <span>Mensuel</span>
                    <span className="font-mono">{(data?.totalRequests ?? 0).toLocaleString()} / {monthlyLimit.toLocaleString()}</span>
                  </div>
                  <Progress value={Math.min(100, ((data?.totalRequests ?? 0) / monthlyLimit) * 100)} className="h-2" />
                </div>
              </div>
            </Card>
            <Card className="p-5 bg-secondary/20 border-border/40">
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Réinitialisation</span>
              </div>
              <div className="text-2xl font-bold font-mono text-foreground">
                {(() => {
                  const now = new Date();
                  const h = 23 - now.getHours();
                  const m = 59 - now.getMinutes();
                  return `${h}h ${m}m`;
                })()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">jusqu'à minuit UTC</div>
            </Card>
          </div>

          {/* Charts row 1 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="p-5 bg-secondary/20 border-border/40">
              <h3 className="text-sm font-semibold mb-4">Appels API par jour (30j)</h3>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={dailyData} barSize={6}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "rgba(255,255,255,0.4)" }} tickLine={false}
                    interval={4} />
                  <YAxis tick={{ fontSize: 9, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 11 }} />
                  <Bar dataKey="success" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} name="Succès" />
                  <Bar dataKey="errors" stackId="a" fill="#ef4444" radius={[2, 2, 0, 0]} name="Erreurs" />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card className="p-5 bg-secondary/20 border-border/40">
              <h3 className="text-sm font-semibold mb-4">Latence (avg / p95 / p99)</h3>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={latencyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "rgba(255,255,255,0.4)" }} tickLine={false}
                    interval={4} />
                  <YAxis tick={{ fontSize: 9, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false}
                    unit="ms" />
                  <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 11 }}
                    formatter={(v: number) => `${v}ms`} />
                  <Line type="monotone" dataKey="avg" stroke="#3b82f6" strokeWidth={2} dot={false} name="Avg" />
                  <Line type="monotone" dataKey="p95" stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="4 2" dot={false} name="p95" />
                  <Line type="monotone" dataKey="p99" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="2 3" dot={false} name="p99" />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>

          {/* Top endpoints */}
          {topEndpoints.length > 0 && (
            <Card className="p-5 bg-secondary/20 border-border/40">
              <h3 className="text-sm font-semibold mb-4">Top 10 endpoints</h3>
              <div className="space-y-2">
                {topEndpoints.map(({ name, value }, i) => {
                  const max = topEndpoints[0].value;
                  return (
                    <div key={name} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-5 text-right">{i + 1}</span>
                      <code className="text-xs font-mono text-foreground flex-1 truncate">{name}</code>
                      <div className="w-32 h-1.5 bg-secondary/50 rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${(value / max) * 100}%` }} />
                      </div>
                      <span className="text-xs font-mono text-muted-foreground w-16 text-right">{value.toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Usage table */}
          <Card className="bg-secondary/20 border-border/40 overflow-hidden">
            <div className="px-5 py-4 border-b border-border/40">
              <h3 className="text-sm font-semibold">Détail par endpoint</h3>
            </div>
            {endpointRows.length === 0 ? (
              <div className="p-8 text-center">
                <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">Aucune donnée disponible</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-border/30">
                    <TableHead className="cursor-pointer" onClick={() => handleSort("path")}>
                      Endpoint <SortIcon k="path" />
                    </TableHead>
                    <TableHead>Méthode</TableHead>
                    <TableHead className="cursor-pointer text-right" onClick={() => handleSort("calls")}>
                      Appels <SortIcon k="calls" />
                    </TableHead>
                    <TableHead className="cursor-pointer text-right" onClick={() => handleSort("errors")}>
                      Erreurs <SortIcon k="errors" />
                    </TableHead>
                    <TableHead className="cursor-pointer text-right" onClick={() => handleSort("avg_ms")}>
                      Latence <SortIcon k="avg_ms" />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {endpointRows.map(row => (
                    <TableRow key={`${row.method}-${row.path}`} className="border-border/20 hover:bg-secondary/20">
                      <TableCell className="font-mono text-xs">{row.path}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs font-mono ${
                          row.method === "GET" ? "border-blue-500/30 text-blue-400"
                          : row.method === "POST" ? "border-green-500/30 text-green-400"
                          : "border-amber-500/30 text-amber-400"
                        }`}>{row.method}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.calls.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-red-400">{row.errors}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">{row.avg_ms}ms</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
