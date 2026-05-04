import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { BarChart3, RefreshCcw, Users } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useAuth } from "@/lib/auth";
import { getFounderMvp, type FounderMvpData } from "@/services/api/founderService";
import { formatXOF } from "@/lib/api";
import { EmptyHint, ScreenContainer, SectionIntro, SkeletonCard } from "@/components/premium/PremiumStates";

type PeriodOption = "7d" | "30d" | "90d";

function toPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export default function FounderDashboard() {
  const { token, isFounder } = useAuth();
  const [period, setPeriod] = useState<PeriodOption>("30d");

  const founderQuery = useQuery({
    queryKey: ["founder-mvp-dashboard", period],
    enabled: Boolean(token),
    queryFn: () => getFounderMvp(token, period),
  });

  const chartData = useMemo(() => {
    const data = founderQuery.data;
    if (!data) return [];
    const activatedMap = new Map(
      data.series.activatedUsers.map((point) => [point.date, point.activatedUsers ?? 0]),
    );
    return data.series.newUsers.map((point) => ({
      date: point.date.slice(5),
      newUsers: point.newUsers ?? 0,
      activatedUsers: activatedMap.get(point.date) ?? 0,
    }));
  }, [founderQuery.data]);

  const txTypeData = useMemo(
    () =>
      (founderQuery.data?.breakdowns.txByType ?? []).map((row) => ({
        type: row.type,
        volume: row.volume,
        count: row.count,
      })),
    [founderQuery.data],
  );

  if (!isFounder) {
    return <Redirect to="/dashboard" />;
  }

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Founder Mode" />
      <ScreenContainer>
        <SectionIntro
          title="Founder Analytics Dashboard"
          subtitle="Activation, retention proxy, wallet/tontine signals et traction pour piloter la croissance."
          actions={
            <div className="flex items-center gap-2">
              {(["7d", "30d", "90d"] as PeriodOption[]).map((option) => (
                <Button
                  key={option}
                  variant={period === option ? "default" : "outline"}
                  className="rounded-xl"
                  onClick={() => setPeriod(option)}
                >
                  {option}
                </Button>
              ))}
              <Button
                variant="outline"
                className="rounded-xl"
                onClick={() => founderQuery.refetch()}
              >
                <RefreshCcw className="h-4 w-4" />
                Refresh
              </Button>
            </div>
          }
        />

        {founderQuery.isLoading ? <SkeletonCard rows={6} /> : null}

        {!founderQuery.isLoading && founderQuery.data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Activation rate" value={toPercent(founderQuery.data.kpis.activationRate)} />
              <KpiCard label="WAU/MAU proxy" value={toPercent(founderQuery.data.kpis.wauMauProxy)} />
              <KpiCard
                label="Wallet adoption"
                value={toPercent(founderQuery.data.kpis.walletAdoptionRate)}
              />
              <KpiCard label="Tx success" value={toPercent(founderQuery.data.kpis.txSuccessRate)} />
              <KpiCard
                label="Repeat users"
                value={toPercent(founderQuery.data.kpis.repeatUserRate)}
              />
              <KpiCard
                label="Savings stickiness"
                value={toPercent(founderQuery.data.kpis.savingsStickiness)}
              />
              <KpiCard
                label="First value time"
                value={`${founderQuery.data.kpis.avgFirstValueHours.toFixed(1)}h`}
              />
              <KpiCard
                label="Avg tontine fill"
                value={founderQuery.data.kpis.avgTontineFillRate.toFixed(1)}
              />
            </div>

            <Card className="rounded-3xl border-black/5 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4" />
                  New users vs activated users
                </CardTitle>
              </CardHeader>
              <CardContent>
                {chartData.length === 0 ? (
                  <EmptyHint
                    title="Series unavailable"
                    description="No data points were returned for the selected period."
                  />
                ) : (
                  <ChartContainer
                    config={{
                      newUsers: { label: "Nouveaux", color: "#111827" },
                      activatedUsers: { label: "Activés", color: "#059669" },
                    }}
                    className="h-[260px] w-full"
                  >
                    <AreaChart data={chartData}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Area
                        type="monotone"
                        dataKey="newUsers"
                        stroke="var(--color-newUsers)"
                        fill="var(--color-newUsers)"
                        fillOpacity={0.15}
                      />
                      <Area
                        type="monotone"
                        dataKey="activatedUsers"
                        stroke="var(--color-activatedUsers)"
                        fill="var(--color-activatedUsers)"
                        fillOpacity={0.2}
                      />
                    </AreaChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-3xl border-black/5 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <BarChart3 className="h-4 w-4" />
                  Volume by transaction type
                </CardTitle>
              </CardHeader>
              <CardContent>
                {txTypeData.length === 0 ? (
                  <EmptyHint
                    title="Breakdown unavailable"
                    description="No transaction breakdown was returned for the selected period."
                  />
                ) : (
                  <ChartContainer
                    config={{ volume: { label: "Volume", color: "#2563eb" } }}
                    className="h-[260px] w-full"
                  >
                    <BarChart data={txTypeData}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" />
                      <XAxis dataKey="type" />
                      <YAxis />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="volume" fill="var(--color-volume)" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-3xl border-black/5 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Totals & health</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Stat label="Total users" value={String(founderQuery.data.totals.totalUsers)} />
                <Stat
                  label={`New users (${founderQuery.data.period})`}
                  value={String(founderQuery.data.totals.newUsersInPeriod)}
                />
                <Stat label="Active tontines" value={String(founderQuery.data.totals.activeTontines)} />
                <Stat label="Wallets adopted" value={String(founderQuery.data.totals.walletsAdopted)} />
                <Stat
                  label="Tx completed"
                  value={String(founderQuery.data.totals.transactionsCompleted)}
                />
                <Stat
                  label="Tx volume"
                  value={formatXOF(founderQuery.data.totals.transactionVolume)}
                />
                <Stat
                  label="Active savings users"
                  value={String(founderQuery.data.totals.activeSavingsUsers)}
                />
                <Stat
                  label="Guard mode"
                  value={founderQuery.data.founderGuardOpen ? "open" : "restricted"}
                />
              </CardContent>
            </Card>
          </>
        ) : null}

        {founderQuery.isError ? (
          <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
            Founder dashboard unavailable. Verify Founder allowlist or API route availability.
          </div>
        ) : null}
      </ScreenContainer>
      <BottomNav />
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="rounded-2xl border-black/5 shadow-sm">
      <CardContent className="space-y-1 p-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</p>
        <p className="text-lg font-bold text-black">{value}</p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 font-semibold text-black">{value}</p>
    </div>
  );
}
