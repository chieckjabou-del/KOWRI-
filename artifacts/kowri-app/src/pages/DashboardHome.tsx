import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Clock3, Loader2, Wallet } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { formatXOF, relativeTime } from "@/lib/api";
import { getPrimaryWallet, getWalletTransactions } from "@/services/api/walletService";
import { listUserTontines } from "@/services/api/tontineService";
import { walletActivityPreview } from "@/features/wallet/wallet-ui";
import {
  EmptyHint,
  ScreenContainer,
  SectionIntro,
  SkeletonCard,
} from "@/components/premium/PremiumStates";

export default function DashboardHome() {
  const { token, user } = useAuth();

  const walletQuery = useQuery({
    queryKey: ["akwe-dashboard-wallet", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => getPrimaryWallet(token, user!.id),
  });

  const wallet = walletQuery.data?.wallet;

  const txQuery = useQuery({
    queryKey: ["akwe-dashboard-tx", wallet?.id],
    enabled: Boolean(wallet?.id),
    queryFn: () => getWalletTransactions(token, wallet!.id, 8),
  });

  const tontinesQuery = useQuery({
    queryKey: ["akwe-dashboard-tontines", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => listUserTontines(token),
  });

  const recentActivity = useMemo(
    () => walletActivityPreview(txQuery.data?.transactions ?? []),
    [txQuery.data?.transactions],
  );

  const primaryTontine = (tontinesQuery.data?.tontines ?? [])[0];
  const usingMock = Boolean(
    walletQuery.data?.usingMock || txQuery.data?.usingMock || tontinesQuery.data?.usingMock,
  );

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Dashboard" />
      <ScreenContainer>
        <SectionIntro
          title="Ton espace Akwé"
          subtitle="Solde, tontines et activité récente. Tout est prêt pour agir en moins de 60 secondes."
          actions={
            <Link href="/tontine?create=1&demo=1&creator=1">
              <Button className="press-feedback rounded-xl bg-black text-white hover:bg-black/90">
                Lancer une tontine
              </Button>
            </Link>
          }
        />
        {usingMock ? (
          <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
            Mode simulation active: le frontend reste utilisable meme si certains endpoints ne repondent pas.
          </div>
        ) : null}

        <Card className="premium-card premium-hover rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Solde disponible</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {walletQuery.isLoading || !wallet ? (
              <SkeletonCard rows={4} />
            ) : (
              <>
                <p className="text-4xl font-black tracking-tight text-black">
                  {formatXOF(wallet.availableBalance)}
                </p>
                <p className="text-xs text-gray-500">
                  Cap prêt à utiliser maintenant. Tes actions clés sont juste en dessous.
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Link href="/send">
                    <Button className="press-feedback h-12 w-full rounded-xl bg-black text-white hover:bg-black/90">
                      Envoyer
                    </Button>
                  </Link>
                  <Link href="/wallet">
                    <Button variant="outline" className="press-feedback h-12 w-full rounded-xl">
                      Deposer
                    </Button>
                  </Link>
                  <Link href="/wallet">
                    <Button variant="outline" className="press-feedback h-12 w-full rounded-xl">
                      Retirer
                    </Button>
                  </Link>
                  <Link href="/wallet">
                    <Button variant="outline" className="press-feedback h-12 w-full rounded-xl">
                      Recevoir
                    </Button>
                  </Link>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="premium-card premium-hover rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">Acces direct a la tontine</CardTitle>
            <Link href="/tontine">
              <Button variant="outline" className="press-feedback rounded-xl">
                Voir tout
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {tontinesQuery.isLoading ? (
              <SkeletonCard rows={2} className="bg-transparent px-0 py-0 shadow-none border-none" />
            ) : primaryTontine ? (
              <Link href={`/tontine/${primaryTontine.id}`}>
                <div className="premium-hover cursor-pointer rounded-2xl border border-gray-100 bg-white px-4 py-4 transition hover:border-black/15">
                  <p className="text-sm font-semibold text-black">{primaryTontine.name}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {formatXOF(primaryTontine.contributionAmount)} - {primaryTontine.memberCount}/{primaryTontine.maxMembers} membres
                  </p>
                  <div className="mt-3 h-1.5 rounded-full bg-gray-100">
                    <div
                      className="h-1.5 rounded-full bg-black"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round((primaryTontine.currentRound / Math.max(primaryTontine.totalRounds, 1)) * 100),
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              </Link>
            ) : (
              <EmptyHint
                title="Aucune tontine pour le moment"
                description="Lance la tienne en 30 secondes pour débloquer un cycle clair et visible."
              />
            )}
          </CardContent>
        </Card>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base font-semibold">Apercu activite recente</CardTitle>
            <Link href="/wallet">
              <Button variant="outline" className="press-feedback rounded-xl">
                Ouvrir wallet
                <Wallet className="h-4 w-4" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {txQuery.isLoading ? (
              <div className="flex items-center gap-2 py-3 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Chargement de l'activite premium...
              </div>
            ) : recentActivity.length === 0 ? (
              <EmptyHint
                title="Pas encore d'activité"
                description="Ton historique va apparaître ici après ton premier dépôt, retrait ou transfert."
              />
            ) : (
              recentActivity.map((tx, index) => (
                <div
                  key={tx.id}
                  className="premium-hover flex items-center justify-between rounded-xl border border-gray-100 bg-white px-3 py-3"
                  style={{
                    animation: "premium-page-enter 320ms cubic-bezier(0.16, 1, 0.3, 1)",
                    animationDelay: `${Math.min(index * 60, 280)}ms`,
                    animationFillMode: "both",
                  }}
                >
                  <div>
                    <p className="text-sm font-medium text-black">{tx.description}</p>
                    <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                      <Clock3 className="h-3 w-3" />
                      {relativeTime(tx.createdAt)}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-black">{formatXOF(tx.amount)}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </ScreenContainer>
      <BottomNav />
    </div>
  );
}
