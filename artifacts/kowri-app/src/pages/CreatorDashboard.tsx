import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Coins, Loader2, TrendingUp, Users } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { formatXOF } from "@/lib/api";
import {
  getCommunityPools,
  getCreatorDashboard,
  getTontineContributionSnapshot,
} from "@/services/api/creatorService";
import { EmptyHint, ScreenContainer, SectionIntro, SkeletonCard } from "@/components/premium/PremiumStates";

interface CreatorTontineRevenueRow {
  id: string;
  name: string;
  communityName: string;
  memberCount: number;
  contributionAmount: number;
  totalContributed: number;
  estimatedCreatorRevenue: number;
  creatorFeeRate: number;
  status: string;
}

export default function CreatorDashboard() {
  const { token, user } = useAuth();

  const dashboardQuery = useQuery({
    queryKey: ["creator-dashboard-machine", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => getCreatorDashboard(token, user!.id),
  });

  const communities = dashboardQuery.data?.dashboard.communities ?? [];

  const poolsQuery = useQuery({
    queryKey: ["creator-dashboard-machine-pools", communities.map((item) => item.id).join(",")],
    enabled: communities.length > 0,
    queryFn: async (): Promise<CreatorTontineRevenueRow[]> => {
      const rows: CreatorTontineRevenueRow[] = [];
      for (const community of communities) {
        const pools = await getCommunityPools(token, community.id);
        for (const rawTontine of pools.tontines) {
          const tontineId = typeof rawTontine.id === "string" ? rawTontine.id : "";
          if (!tontineId) continue;
          const snap = await getTontineContributionSnapshot(token, tontineId).catch(() => null);
          const memberCount = Number(
            rawTontine.memberCount ?? snap?.memberCount ?? 0,
          );
          const contributionAmount = Number(
            rawTontine.contributionAmount ?? snap?.contributionAmount ?? 0,
          );
          const totalContributed = Number(snap?.totalContributed ?? 0);
          const creatorFeeRate = Number(community.creatorFeeRate ?? 5);
          rows.push({
            id: tontineId,
            name: typeof rawTontine.name === "string" ? rawTontine.name : `Tontine ${tontineId.slice(0, 6)}`,
            communityName: community.name,
            memberCount,
            contributionAmount,
            totalContributed,
            // Backend formula: creatorFee = transactionAmount * creatorFeeRate / 100
            estimatedCreatorRevenue: totalContributed * (creatorFeeRate / 100),
            creatorFeeRate,
            status: typeof rawTontine.status === "string" ? rawTontine.status : "pending",
          });
        }
      }
      return rows;
    },
  });

  const rows = poolsQuery.data ?? [];
  const totalTontines = rows.length;
  const totalMembersInTontines = rows.reduce((sum, row) => sum + row.memberCount, 0);
  const averageFeeRate = communities.length
    ? communities.reduce((sum, row) => sum + row.creatorFeeRate, 0) / communities.length
    : 0;

  const primaryRow = rows[0];
  const oneMemberGain = primaryRow
    ? primaryRow.contributionAmount * (primaryRow.creatorFeeRate / 100)
    : 0;
  const hundredMembersVisual = oneMemberGain * 100;

  const topRows = useMemo(
    () => [...rows].sort((a, b) => b.estimatedCreatorRevenue - a.estimatedCreatorRevenue),
    [rows],
  );

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Creator Dashboard" />
      <ScreenContainer>
        <SectionIntro
          title="Tu gagnes de l'argent avec ta communaute"
          subtitle="Données réelles connectées au backend créateur existant, sans logique inventée."
          actions={
            <Link href="/creator">
              <Button variant="outline" className="press-feedback rounded-xl">
                Creer ma communaute
              </Button>
            </Link>
          }
        />

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardContent className="space-y-3 pt-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">UX virale</p>
            <p className="text-sm font-semibold text-black">
              Chaque membre qui rejoint ta tontine te rapporte environ {averageFeeRate.toFixed(0)}%
              {" "}sur les contributions enregistrees.
            </p>
            <p className="text-xs text-gray-500">
              Simulation visuelle: si tu ajoutes 100 personnes sur un tour de reference,
              tu peux generer {formatXOF(hundredMembersVisual)} de commission createur.
            </p>
          </CardContent>
        </Card>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Gains createur (reels)"
            value={formatXOF(dashboardQuery.data?.dashboard.stats.totalEarnings ?? 0)}
            icon={<Coins className="h-4 w-4" />}
          />
          <MetricCard
            label="Membres dans tes tontines"
            value={`${totalMembersInTontines}`}
            icon={<Users className="h-4 w-4" />}
          />
          <MetricCard
            label="Tontines creees"
            value={`${totalTontines}`}
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <MetricCard
            label="Volume communaute"
            value={formatXOF(dashboardQuery.data?.dashboard.stats.totalVolume ?? 0)}
            icon={<Coins className="h-4 w-4" />}
          />
        </section>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">
              Revenus generes par tontine
            </CardTitle>
            <Link href="/tontine">
              <Button className="press-feedback rounded-xl bg-black text-white hover:bg-black/90">
                Creer une tontine et gagner de l'argent
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {dashboardQuery.isLoading || poolsQuery.isLoading ? (
              <SkeletonCard rows={5} className="bg-transparent px-0 py-0 shadow-none border-none" />
            ) : topRows.length === 0 ? (
              <EmptyHint
                title="Aucune tontine reliee a tes communautes"
                description="Cree une tontine et active le mode createur pour monetiser les contributions."
                action={
                  <Link href="/tontine">
                    <Button className="press-feedback rounded-xl bg-black text-white hover:bg-black/90">
                      Creer une tontine
                    </Button>
                  </Link>
                }
              />
            ) : (
              topRows.map((row) => (
                <Link key={row.id} href={`/tontine/${row.id}`}>
                  <div className="premium-hover cursor-pointer rounded-2xl border border-gray-100 bg-white px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-black">{row.name}</p>
                        <p className="mt-1 text-xs text-gray-500">
                          {row.communityName} • {row.memberCount} membres • statut {row.status}
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          Cotisation: {formatXOF(row.contributionAmount)} • Taux: {row.creatorFeeRate.toFixed(0)}%
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                          Gain creeateur
                        </p>
                        <p className="text-sm font-bold text-emerald-700">
                          {formatXOF(row.estimatedCreatorRevenue)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                      Total contribue (endpoint /tontines/:id): {formatXOF(row.totalContributed)}
                    </div>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        {(dashboardQuery.error || poolsQuery.error) ? (
          <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
            Impossible de charger certaines donnees createur depuis le backend.
          </div>
        ) : null}

        {(dashboardQuery.isLoading || poolsQuery.isLoading) ? (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Synchronisation des donnees createur...
          </div>
        ) : null}
      </ScreenContainer>
      <BottomNav />
    </div>
  );
}

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="premium-card premium-hover rounded-2xl border-black/5 shadow-sm">
      <CardContent className="space-y-1.5 p-4">
        <div className="text-gray-500">{icon}</div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</p>
        <p className="text-sm font-semibold text-black">{value}</p>
      </CardContent>
    </Card>
  );
}
