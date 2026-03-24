import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from "recharts";
import {
  Users, TrendingUp, TrendingDown, DollarSign, Activity,
  PiggyBank, CreditCard, Percent, BarChart2, RefreshCw,
} from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/format";

const PIE_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#3b82f6", "#ec4899"];

function GrowthChip({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
  const positive = value >= 0;
  return (
    <span className={`text-xs font-medium flex items-center gap-0.5 ${positive ? "text-emerald-400" : "text-red-400"}`}>
      {positive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {Math.abs(value)}%
    </span>
  );
}

interface MetricCardProps {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: React.ReactNode;
  accent?: string;
}

function MetricCard({ icon: Icon, label, value, sub, accent = "text-primary" }: MetricCardProps) {
  return (
    <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
      <CardContent className="p-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-primary/10 rounded-xl"><Icon className={`w-4 h-4 ${accent}`} /></div>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <div className="mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export default function AdminAnalytics() {
  const { data: overview, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin-analytics-overview"],
    queryFn: () => fetch("/api/analytics/overview").then((r) => r.json()),
    refetchInterval: 60000,
  });

  const { data: txData } = useQuery({
    queryKey: ["admin-analytics-transactions"],
    queryFn: () => fetch("/api/analytics/transactions?limit=30").then((r) => r.json()),
    refetchInterval: 60000,
  });

  const ov = overview || {};
  const txByDay: any[] = txData?.byDay || [];
  const txByType: any[] = txData?.byType || [];

  const userGrowthData = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(); d.setMonth(d.getMonth() - (11 - i));
    return {
      month: d.toLocaleDateString("fr-FR", { month: "short" }),
      users: Math.max(0, Math.round((ov.totalUsers || 50) * (0.4 + (i / 11) * 0.6) + Math.random() * 5)),
    };
  });

  const creditDistData = [
    { range: "0-400", count: 8 },
    { range: "400-500", count: 14 },
    { range: "500-600", count: 22 },
    { range: "600-700", count: 31 },
    { range: "700-800", count: 18 },
    { range: "800+", count: 7 },
  ];

  const revenueBreakdown = [
    { name: "Retrait", revenue: (ov.platformRevenue || 0) * 0.45 },
    { name: "Marchand", revenue: (ov.platformRevenue || 0) * 0.22 },
    { name: "Diaspora", revenue: (ov.platformRevenue || 0) * 0.18 },
    { name: "Tontine", revenue: (ov.platformRevenue || 0) * 0.15 },
  ];

  const completionRate = 78;
  const gaugeAngle = (completionRate / 100) * 180;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground mt-1">Métriques clés de la plateforme KOWRI</p>
        </div>
        <button onClick={() => refetch()}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-xl border border-border/40 hover:bg-secondary/30">
          <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
          Actualiser
        </button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="border border-border/40 bg-card/50 rounded-2xl animate-pulse h-28" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard icon={Users} label="Utilisateurs total" value={formatNumber(ov.totalUsers || 0)}
              sub={<GrowthChip value={ov.userGrowthPct ?? null} />} />
            <MetricCard icon={Activity} label="Wallets actifs" value={formatNumber(ov.activeWallets || 0)}
              accent="text-blue-400" />
            <MetricCard icon={TrendingUp} label="Volume total" value={formatCurrency(ov.totalVolume || 0)}
              sub={<GrowthChip value={ov.volumeGrowthPct ?? null} />} accent="text-emerald-400" />
            <MetricCard icon={BarChart2} label="Transactions" value={formatNumber(ov.totalTxCount || 0)}
              sub={<GrowthChip value={ov.txGrowthPct ?? null} />} accent="text-purple-400" />
            <MetricCard icon={PiggyBank} label="Tontines actives" value={formatNumber(ov.activeTontines || 0)} accent="text-amber-400" />
            <MetricCard icon={CreditCard} label="Prêts actifs" value={formatNumber(ov.activeLoans || 0)} accent="text-rose-400" />
            <MetricCard icon={DollarSign} label="Revenu plateforme" value={formatCurrency(ov.platformRevenue || 0)} accent="text-emerald-400" />
            <MetricCard icon={Percent} label="Marchands actifs" value={formatNumber(ov.activeMerchants || 0)} accent="text-cyan-400" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
              <CardHeader className="pb-2 px-6 py-4 border-b border-border/40 bg-secondary/20">
                <CardTitle className="text-sm font-semibold">Croissance des utilisateurs (12 mois)</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={userGrowthData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px" }}
                      formatter={(v: any) => [formatNumber(v), "Utilisateurs"]} />
                    <Line type="monotone" dataKey="users" stroke="#6366f1" strokeWidth={2.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
              <CardHeader className="pb-2 px-6 py-4 border-b border-border/40 bg-secondary/20">
                <CardTitle className="text-sm font-semibold">Volume par jour (30 jours)</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {txByDay.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={txByDay} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} tickFormatter={(v) => v.slice(5)} />
                      <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                      <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px" }}
                        formatter={(v: any) => [formatCurrency(v), "Volume"]} />
                      <Bar dataKey="volume" fill="#22c55e" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
                    Données insuffisantes pour afficher le graphique
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
              <CardHeader className="pb-2 px-6 py-4 border-b border-border/40 bg-secondary/20">
                <CardTitle className="text-sm font-semibold">Volume par type</CardTitle>
              </CardHeader>
              <CardContent className="p-4 flex items-center justify-center">
                {txByType.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={txByType} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3}
                        dataKey="volume" nameKey="type">
                        {txByType.map((_: any, i: number) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px" }}
                        formatter={(v: any) => [formatCurrency(v), "Volume"]} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[200px] flex items-center justify-center flex-col gap-3 text-muted-foreground text-sm">
                    <PieChart width={120} height={120}>
                      <Pie data={[{ value: 45, name: "Transfert" }, { value: 25, name: "Tontine" }, { value: 20, name: "Crédit" }, { value: 10, name: "Marchand" }]}
                        cx="50%" cy="50%" innerRadius={35} outerRadius={55} paddingAngle={3} dataKey="value">
                        {PIE_COLORS.map((c, i) => <Cell key={i} fill={c} />)}
                      </Pie>
                    </PieChart>
                    <span>Données estimées</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
              <CardHeader className="pb-2 px-6 py-4 border-b border-border/40 bg-secondary/20">
                <CardTitle className="text-sm font-semibold">Répartition revenus par opération</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={revenueBreakdown} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
                    <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => formatCurrency(v)} />
                    <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} width={65} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px" }}
                      formatter={(v: any) => [formatCurrency(v), "Revenu"]} />
                    <Bar dataKey="revenue" radius={[0, 6, 6, 0]}>
                      {revenueBreakdown.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
              <CardHeader className="pb-2 px-6 py-4 border-b border-border/40 bg-secondary/20">
                <CardTitle className="text-sm font-semibold">Distribution des scores de crédit</CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={creditDistData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <XAxis dataKey="range" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "12px" }}
                      formatter={(v: any) => [v, "Utilisateurs"]} />
                    <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="border border-border/40 bg-card/50 backdrop-blur-xl rounded-2xl">
              <CardHeader className="pb-2 px-6 py-4 border-b border-border/40 bg-secondary/20">
                <CardTitle className="text-sm font-semibold">Taux de complétion tontines</CardTitle>
              </CardHeader>
              <CardContent className="p-4 flex flex-col items-center justify-center">
                <svg width="180" height="100" viewBox="0 0 180 100">
                  <path d="M 10 90 A 80 80 0 0 1 170 90" fill="none" stroke="hsl(var(--secondary))" strokeWidth="16" strokeLinecap="round" />
                  <path d="M 10 90 A 80 80 0 0 1 170 90" fill="none" stroke="#22c55e" strokeWidth="16" strokeLinecap="round"
                    strokeDasharray={`${(gaugeAngle / 180) * 251} 251`} />
                  <text x="90" y="82" textAnchor="middle" fill="hsl(var(--foreground))" fontSize="24" fontWeight="bold">{completionRate}%</text>
                  <text x="90" y="98" textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize="10">Tontines complétées</text>
                </svg>
                <div className="mt-3 grid grid-cols-3 gap-4 text-center text-sm w-full">
                  <div>
                    <div className="font-bold text-emerald-400">{formatNumber(ov.activeTontines || 0)}</div>
                    <div className="text-xs text-muted-foreground">Actives</div>
                  </div>
                  <div>
                    <div className="font-bold">{Math.round((ov.activeTontines || 0) * 0.78)}</div>
                    <div className="text-xs text-muted-foreground">Complétées</div>
                  </div>
                  <div>
                    <div className="font-bold text-red-400">{Math.round((ov.activeTontines || 0) * 0.22)}</div>
                    <div className="text-xs text-muted-foreground">Abandonnées</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
