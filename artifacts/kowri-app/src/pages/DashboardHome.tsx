import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Clock3, Copy, Loader2, MessageCircle, Wallet } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { formatXOF, relativeTime } from "@/lib/api";
import { getDashboardHomeData } from "@/services/api/dashboardService";
import { walletActivityPreview } from "@/features/wallet/wallet-ui";
import { makeCacheKey, readCachedValue, writeCachedValue } from "@/lib/localCache";
import { getCacheMaxAgeMs, getCacheTtlMs } from "@/lib/cachePolicy";
import { hasMajorDataDrift } from "@/lib/localCache";
import type { WalletSummary, WalletTransaction, TontineListItem } from "@/types/akwe";
import {
  EmptyHint,
  ScreenContainer,
  SectionIntro,
  SkeletonCard,
} from "@/components/premium/PremiumStates";
import { TrustPill } from "@/components/trust/TrustPill";
import {
  buildReferralInviteLink,
  buildWhatsAppInviteMessage,
  buildWhatsAppShareUrl,
  makeReferralCodeFromUserId,
} from "@/lib/growth";
import { trackUxAction } from "@/lib/frontendMonitor";

export default function DashboardHome() {
  const { token, user } = useAuth();
  const [copiedInvite, setCopiedInvite] = useState(false);
  const cacheNamespace = useMemo(
    () => makeCacheKey("dashboard", user?.id),
    [user?.id],
  );
  const cachedWallet = useMemo(
    () =>
      readCachedValue<{ wallet: WalletSummary; usingMock: boolean }>(
        `${cacheNamespace}:wallet`,
        getCacheMaxAgeMs("wallet-summary"),
      )?.data ?? null,
    [cacheNamespace],
  );
  const cachedTx = useMemo(
    () =>
      readCachedValue<{ transactions: WalletTransaction[]; usingMock: boolean }>(
        `${cacheNamespace}:tx`,
        getCacheMaxAgeMs("wallet-transactions"),
      )?.data ?? null,
    [cacheNamespace],
  );
  const cachedTontines = useMemo(
    () =>
      readCachedValue<{ tontines: TontineListItem[]; usingMock: boolean }>(
        `${cacheNamespace}:tontines`,
        getCacheMaxAgeMs("tontines-list"),
      )?.data ?? null,
    [cacheNamespace],
  );

  const dashboardQuery = useQuery({
    queryKey: ["akwe-dashboard-aggregate", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => getDashboardHomeData(token, user!.id),
    initialData:
      cachedWallet?.wallet != null
        ? {
            wallet: cachedWallet.wallet,
            transactions: cachedTx?.transactions ?? [],
            tontines: cachedTontines?.tontines ?? [],
            notifications: [],
            usingMock: Boolean(
              cachedWallet.usingMock || cachedTx?.usingMock || cachedTontines?.usingMock,
            ),
            source: "composed",
          }
        : undefined,
  });

  const wallet = dashboardQuery.data?.wallet ?? null;
  const transactions = dashboardQuery.data?.transactions ?? [];
  const tontines = dashboardQuery.data?.tontines ?? [];

  useEffect(() => {
    if (dashboardQuery.data?.wallet) {
      const walletPayload = {
        wallet: dashboardQuery.data.wallet,
        usingMock: dashboardQuery.data.usingMock,
      };
      if (hasMajorDataDrift(`${cacheNamespace}:wallet`, walletPayload)) {
        void dashboardQuery.refetch();
      }
      writeCachedValue(`${cacheNamespace}:wallet`, walletPayload);
    }
  }, [cacheNamespace, dashboardQuery.data, dashboardQuery]);

  useEffect(() => {
    if (dashboardQuery.data) {
      writeCachedValue(`${cacheNamespace}:tx`, {
        transactions: dashboardQuery.data.transactions,
        usingMock: dashboardQuery.data.usingMock,
      });
    }
  }, [cacheNamespace, dashboardQuery.data]);

  useEffect(() => {
    if (dashboardQuery.data) {
      writeCachedValue(`${cacheNamespace}:tontines`, {
        tontines: dashboardQuery.data.tontines,
        usingMock: dashboardQuery.data.usingMock,
      });
    }
  }, [cacheNamespace, dashboardQuery.data]);

  const recentActivity = useMemo(
    () => walletActivityPreview(transactions),
    [transactions],
  );

  const primaryTontine = tontines[0];
  const usingMock = Boolean(dashboardQuery.data?.usingMock);
  const renderingFromCache =
    !dashboardQuery.isFetched && Boolean(cachedWallet || cachedTx || cachedTontines);
  const walletTrustState = dashboardQuery.isFetching
    ? "syncing"
    : renderingFromCache
      ? "fallback"
      : "updated";
  const referralCode = makeReferralCodeFromUserId(user?.id);
  const referralLink = buildReferralInviteLink(referralCode);
  const referralMessage = buildWhatsAppInviteMessage({
    inviteLink: referralLink,
    referrerCode: referralCode,
    firstName: user?.firstName ?? "",
  });

  useEffect(() => {
    if (!user?.id) return;
    trackUxAction("growth.activation.dashboard_viewed", {
      userId: user.id,
      route: "dashboard_home",
      hasTontine: tontines.length > 0,
      hasWallet: Boolean(wallet),
    });
  }, [tontines.length, user?.id, wallet]);

  function markFirstValueAction(actionType: "wallet_send" | "wallet_deposit" | "wallet_receive" | "wallet_withdraw"): void {
    trackUxAction("growth.activation.first_value_action", {
      userId: user?.id ?? "anon",
      actionType,
      valueXof: wallet?.availableBalance ?? 0,
    });
  }

  async function copyReferralLink(): Promise<void> {
    await navigator.clipboard.writeText(referralLink).catch(() => undefined);
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 1800);
    trackUxAction("growth.referral.share_completed", {
      userId: user?.id ?? "anon",
      placement: "dashboard_home",
      channel: "copy",
    });
  }

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Dashboard" />
      <ScreenContainer>
        <SectionIntro
          title="Ton espace Akwé"
          subtitle="Solde, tontines et activité récente. Tout est prêt pour agir en moins de 60 secondes."
          actions={
            <Link href="/tontine?create=1&demo=1&creator=1">
              <Button
                className="press-feedback rounded-xl bg-black text-white hover:bg-black/90"
                onClick={() => {
                  trackUxAction("growth.activation.first_value_action", {
                    userId: user?.id ?? "anon",
                    actionType: "tontine_create",
                    valueXof: 0,
                  });
                }}
              >
                Lancer une tontine
              </Button>
            </Link>
          }
        />
        {(usingMock || renderingFromCache) ? (
          <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
            {renderingFromCache
              ? "Affichage instantane depuis cache local, mise a jour en arriere-plan."
              : "Mode simulation active: le frontend reste utilisable meme si certains endpoints ne repondent pas."}
          </div>
        ) : null}
        <TrustPill state={walletTrustState} />

        <Card className="premium-card premium-hover rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Solde disponible</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {dashboardQuery.isLoading || !wallet ? (
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
                    <Button
                      className="press-feedback h-12 w-full rounded-xl bg-black text-white hover:bg-black/90"
                      onClick={() => markFirstValueAction("wallet_send")}
                    >
                      Envoyer
                    </Button>
                  </Link>
                  <Link href="/wallet?action=deposit">
                    <Button
                      variant="outline"
                      className="press-feedback h-12 w-full rounded-xl"
                      onClick={() => markFirstValueAction("wallet_deposit")}
                    >
                      Deposer
                    </Button>
                  </Link>
                  <Link href="/wallet?action=withdraw">
                    <Button
                      variant="outline"
                      className="press-feedback h-12 w-full rounded-xl"
                      onClick={() => markFirstValueAction("wallet_withdraw")}
                    >
                      Retirer
                    </Button>
                  </Link>
                  <Link href="/wallet?action=receive">
                    <Button
                      variant="outline"
                      className="press-feedback h-12 w-full rounded-xl"
                      onClick={() => markFirstValueAction("wallet_receive")}
                    >
                      Recevoir
                    </Button>
                  </Link>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">Invite 3 proches, gagne tes bonus AKWE</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-gray-600">
              Partage sur WhatsApp en 1 clic. Bonus credite apres leur premiere action eligible.
            </p>
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs break-all">
              {referralLink}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button
                className="press-feedback h-11 rounded-xl bg-black text-white hover:bg-black/90"
                onClick={() => {
                  trackUxAction("growth.referral.link_generated", {
                    userId: user?.id ?? "anon",
                    placement: "dashboard_home",
                    referralLink,
                    campaign: "growth-mode",
                  });
                  trackUxAction("growth.referral.share_clicked", {
                    userId: user?.id ?? "anon",
                    placement: "dashboard_home",
                    channel: "whatsapp",
                  });
                  window.open(buildWhatsAppShareUrl(referralMessage), "_blank", "noopener,noreferrer");
                }}
              >
                <MessageCircle className="h-4 w-4" />
                Partager sur WhatsApp
              </Button>
              <Button
                variant="outline"
                className="press-feedback h-11 rounded-xl"
                onClick={() => {
                  trackUxAction("growth.referral.share_clicked", {
                    userId: user?.id ?? "anon",
                    placement: "dashboard_home",
                    channel: "copy",
                  });
                  void copyReferralLink();
                }}
              >
                <Copy className="h-4 w-4" />
                {copiedInvite ? "Lien copié" : "Copier mon lien"}
              </Button>
            </div>
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
            {dashboardQuery.isLoading ? (
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
            {dashboardQuery.isLoading ? (
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
