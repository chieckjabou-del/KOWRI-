import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Copy,
  CreditCard,
  Landmark,
  Loader2,
  SendHorizontal,
  ShieldCheck,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { buildApiUrl, formatXOF, relativeTime } from "@/lib/api";
import {
  depositToWallet,
  getPrimaryWallet,
  getWalletTransactions,
} from "@/services/api/walletService";
import { transactionDirection } from "@/features/wallet/wallet-ui";
import { useToast } from "@/hooks/use-toast";
import { EmptyHint, ScreenContainer, SectionIntro, SkeletonCard } from "@/components/premium/PremiumStates";
import { readCache, writeCache } from "@/lib/localCache";
import { getDeviceProfile } from "@/lib/deviceProfile";
import { invalidateCacheByMutation, CACHE_TTL_MS } from "@/lib/cachePolicy";
import { queueAction } from "@/lib/offlineQueue";
import { trackUxAction } from "@/lib/frontendMonitor";
import { TrustPill } from "@/components/trust/TrustPill";
import { useActionCooldown } from "@/hooks/useActionCooldown";

type SendTransferPayload = {
  fromWalletId: string;
  toWalletId: string;
  amount: number;
  currency: "XOF";
  description: string;
};

async function sendTransfer(
  token: string | null,
  payload: SendTransferPayload,
): Promise<void> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    queueAction({
      id: `offline-transfer-${Date.now()}`,
      type: "transfer",
      payload: payload as unknown as Record<string, unknown>,
      idempotencyKey: `${Date.now()}-wallet-send`,
      endpoint: "/wallet/transfer",
      method: "POST",
      createdAt: Date.now(),
    });
    return;
  }
  const response = await fetch(buildApiUrl("/wallet/transfer"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `${Date.now()}-wallet-send`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Transfert refuse. Verifie le montant ou le destinataire.");
  }
}

function createOfflineActionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function WalletHome() {
  const { token, user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deviceProfile = getDeviceProfile();
  const cacheKey = user?.id ? `wallet-home:${user.id}` : "";
  const [walletSeeded, setWalletSeeded] = useState(() => {
    if (!cacheKey) return null as Awaited<ReturnType<typeof getPrimaryWallet>> | null;
    return readCache<Awaited<ReturnType<typeof getPrimaryWallet>>>(cacheKey);
  });
  const [txSeeded, setTxSeeded] = useState(() => {
    if (!cacheKey) return null as Awaited<ReturnType<typeof getWalletTransactions>> | null;
    return readCache<Awaited<ReturnType<typeof getWalletTransactions>>>(`${cacheKey}:tx`);
  });
  const [showReceive, setShowReceive] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [depositAmount, setDepositAmount] = useState("50000");
  const [sendAmount, setSendAmount] = useState("10000");
  const [recipientWalletId, setRecipientWalletId] = useState("");
  const [copied, setCopied] = useState(false);
  const [walletDisplayBalance, setWalletDisplayBalance] = useState(0);
  const [walletTrustState, setWalletTrustState] = useState<"syncing" | "updated" | "offline-queued">(
    "syncing",
  );
  const [walletDriftHint, setWalletDriftHint] = useState(false);
  const [sendQueuedOffline, setSendQueuedOffline] = useState(false);
  const [depositQueuedOffline, setDepositQueuedOffline] = useState(false);
  const lastWalletBalanceRef = useRef<number | null>(null);
  const [pendingSendConfirm, setPendingSendConfirm] = useState(false);
  const [pendingDepositConfirm, setPendingDepositConfirm] = useState(false);
  const [lastWalletSyncedAt, setLastWalletSyncedAt] = useState<number | null>(null);
  const [lastTxSyncedAt, setLastTxSyncedAt] = useState<number | null>(null);
  const [walletPulse, setWalletPulse] = useState(false);
  const sendCooldown = useActionCooldown(1200);
  const depositCooldown = useActionCooldown(1200);

  const walletQuery = useQuery({
    queryKey: ["akwe-wallet", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => getPrimaryWallet(token, user!.id),
    initialData: walletSeeded ?? undefined,
  });

  const wallet = walletQuery.data?.wallet;
  const usingMockWallet = walletQuery.data?.usingMock ?? false;

  const transactionsQuery = useQuery({
    queryKey: ["akwe-wallet-transactions", wallet?.id],
    enabled: Boolean(wallet?.id),
    queryFn: () => getWalletTransactions(token, wallet!.id, 20),
    initialData: txSeeded ?? undefined,
  });

  const transactions = useMemo(
    () => transactionsQuery.data?.transactions ?? [],
    [transactionsQuery.data?.transactions],
  );
  useEffect(() => {
    if (!cacheKey || !walletQuery.data) return;
    setWalletSeeded(walletQuery.data);
    writeCache(cacheKey, walletQuery.data, { ttlMs: CACHE_TTL_MS.walletSummary });
    setLastWalletSyncedAt(Date.now());
    setWalletPulse(true);
    const timer = window.setTimeout(() => setWalletPulse(false), 900);
    return () => window.clearTimeout(timer);
  }, [cacheKey, walletQuery.data]);

  useEffect(() => {
    if (!cacheKey || !transactionsQuery.data) return;
    setTxSeeded(transactionsQuery.data);
    writeCache(`${cacheKey}:tx`, transactionsQuery.data, { ttlMs: CACHE_TTL_MS.walletTransactions });
    setLastTxSyncedAt(Date.now());
  }, [cacheKey, transactionsQuery.data]);

  const usingMockTransactions = transactionsQuery.data?.usingMock ?? false;

  const depositMutation = useMutation({
    mutationFn: async () => {
      if (!wallet) return;
      const amount = Number(depositAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Montant de depot invalide.");
      }
      await depositToWallet(token, wallet.id, amount);
    },
    onSuccess: async () => {
      setPendingDepositConfirm(false);
      invalidateCacheByMutation("deposit", user?.id ?? null);
      trackUxAction("wallet.deposit.success", {
        amount: Number(depositAmount),
        userId: user?.id ?? "anon",
      });
      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet", user?.id] });
      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet-transactions", wallet?.id] });
      setShowDeposit(false);
      toast({
        title: "Depot enregistre",
        description: "Le wallet a recu ta demande de depot.",
      });
    },
    onError: (error: unknown) => {
      setPendingDepositConfirm(false);
      toast({
        variant: "destructive",
        title: "Depot impossible",
        description: error instanceof Error ? error.message : "Reessaie dans un instant.",
      });
    },
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!wallet) {
        throw new Error("Wallet principal introuvable.");
      }
      const amount = Number(sendAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Montant a envoyer invalide.");
      }
      if (!recipientWalletId.trim()) {
        throw new Error("Ajoute un identifiant wallet destinataire.");
      }
      await sendTransfer(token, {
        fromWalletId: wallet.id,
        toWalletId: recipientWalletId.trim(),
        amount,
        currency: "XOF",
        description: "Transfert Wallet Akwe",
      });
    },
    onSuccess: async () => {
      setPendingSendConfirm(false);
      invalidateCacheByMutation("send", user?.id ?? null);
      trackUxAction("wallet.send.success", {
        amount: Number(sendAmount),
        userId: user?.id ?? "anon",
      });
      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet", user?.id] });
      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet-transactions", wallet?.id] });
      setShowSend(false);
      setRecipientWalletId("");
      setSendAmount("10000");
      toast({
        title: "Transfert envoye",
        description: "Ton envoi a ete lance avec succes.",
      });
    },
    onError: (error: unknown) => {
      setPendingSendConfirm(false);
      if (typeof navigator !== "undefined" && !navigator.onLine && wallet) {
        const idempotencyKey = `${Date.now()}-wallet-send-offline`;
        queueAction({
          id: createOfflineActionId("wallet-send"),
          type: "transfer",
          payload: {
            fromWalletId: wallet.id,
            toWalletId: recipientWalletId.trim(),
            amount: Number(sendAmount),
            currency: "XOF",
            description: "Transfert Wallet Akwe",
          },
          idempotencyKey,
          endpoint: "/wallet/transfer",
          method: "POST",
          createdAt: Date.now(),
        });
        trackUxAction("wallet.send.queued-offline", {
          amount: Number(sendAmount),
          userId: user?.id ?? "anon",
        });
        toast({
          title: "Envoi mis en file hors ligne",
          description: "La transaction sera rejouee automatiquement quand le reseau revient.",
        });
        setShowSend(false);
        setRecipientWalletId("");
        setSendAmount("10000");
        return;
      }
      toast({
        variant: "destructive",
        title: "Transfert bloque",
        description: error instanceof Error ? error.message : "Verifie les informations et reessaie.",
      });
    },
  });

  const loading = walletQuery.isLoading || !wallet;
  const walletFreshMs =
    lastWalletSyncedAt != null ? Math.max(0, Date.now() - lastWalletSyncedAt) : Number.POSITIVE_INFINITY;
  const walletSyncStatus: "syncing" | "updated" | "fallback" =
    walletQuery.isFetching || transactionsQuery.isFetching
      ? "syncing"
      : walletFreshMs <= CACHE_TTL_MS.walletSummary
        ? "updated"
        : "fallback";
  const trustLabel =
    walletSyncStatus === "syncing"
      ? "Synchronisation en cours"
      : walletSyncStatus === "updated"
        ? "Mis a jour"
        : "En attente de refresh";
  const txFreshMs =
    lastTxSyncedAt != null ? Math.max(0, Date.now() - lastTxSyncedAt) : Number.POSITIVE_INFINITY;
  const historyStatus: "syncing" | "updated" | "fallback" =
    transactionsQuery.isFetching
      ? "syncing"
      : txFreshMs <= CACHE_TTL_MS.walletTransactions
        ? "updated"
        : "fallback";

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Wallet" />
      <ScreenContainer>
        <SectionIntro
          title="Ton wallet instantane"
          subtitle="Envoie, recois, depose et suis chaque mouvement avec une lecture claire."
        />
        {(usingMockWallet || usingMockTransactions) && (
          <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
            Mode simulation active: certaines donnees wallet sont affichees en fallback UI.
          </div>
        )}

        <Card className="premium-card premium-hover rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Solde principal</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {loading ? (
              <SkeletonCard rows={4} />
            ) : (
              <>
                <div>
                  <p className={`text-4xl font-black tracking-tight text-black transition-all ${walletPulse ? "gain-pulse" : ""}`}>
                    {formatXOF(wallet.availableBalance)}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Solde total: {formatXOF(wallet.balance)} - Statut: {wallet.status}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <TrustPill state={walletSyncStatus} />
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Securise
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Button
                    className="press-feedback h-12 w-full rounded-xl bg-black text-white hover:bg-black/90"
                    onClick={() => setShowSend(true)}
                  >
                    Envoyer
                  </Button>
                  <Button
                    variant="outline"
                    className="press-feedback h-12 rounded-xl"
                    onClick={() => setShowDeposit(true)}
                  >
                    Deposer
                  </Button>
                  <Button variant="outline" className="press-feedback h-12 rounded-xl" onClick={() => setShowReceive(true)}>
                    Recevoir
                  </Button>
                  <Button
                    variant="outline"
                    className="press-feedback h-12 rounded-xl"
                    onClick={() =>
                      toast({
                        title: "Retrait bientot disponible",
                        description: "Cette action sera active dans une prochaine version.",
                      })
                    }
                  >
                    Retirer
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <section className="grid gap-3 sm:grid-cols-2">
          <Card className="premium-card premium-hover rounded-2xl border-black/5 shadow-sm">
            <CardContent className="flex items-start gap-3 p-5">
              <CreditCard className="mt-0.5 h-5 w-5 text-black" />
              <div>
                <p className="text-sm font-semibold text-black">Paiements rapides</p>
                <p className="mt-1 text-xs text-gray-500">
                  Envois instantanes et suivi des debits en temps reel.
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="premium-card premium-hover rounded-2xl border-black/5 shadow-sm">
            <CardContent className="flex items-start gap-3 p-5">
              <Landmark className="mt-0.5 h-5 w-5 text-black" />
              <div>
                <p className="text-sm font-semibold text-black">Trace complete</p>
                <p className="mt-1 text-xs text-gray-500">
                  Historique detaille pour audit financier et confiance.
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold text-black">Historique des transactions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {transactionsQuery.isLoading ? (
              <SkeletonCard rows={5} className="bg-transparent px-0 py-0 shadow-none border-none" />
            ) : transactions.length === 0 ? (
              <EmptyHint
                title="Aucune transaction pour l'instant"
                description="Ton historique va se remplir automatiquement apres ton premier mouvement."
              />
            ) : (
              transactions.map((tx, index) => {
                const direction = transactionDirection(tx, wallet?.id ?? "");
                const incoming = direction === "incoming";
                return (
                  <div
                    key={tx.id}
                    className="premium-hover flex items-center justify-between rounded-xl border border-gray-100 bg-white px-3 py-3"
                    style={{
                      animation: deviceProfile.reducedMotion
                        ? "none"
                        : "premium-page-enter 320ms cubic-bezier(0.16, 1, 0.3, 1)",
                      animationDelay: `${Math.min(index * 45, 260)}ms`,
                      animationFillMode: "both",
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`rounded-full p-2 ${incoming ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}
                      >
                        {incoming ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-black">{tx.description}</p>
                        <p className="text-xs text-gray-500">{relativeTime(tx.createdAt)}</p>
                      </div>
                    </div>
                    <p className={`text-sm font-bold ${incoming ? "text-emerald-700" : "text-red-700"}`}>
                      {incoming ? "+" : "-"}
                      {formatXOF(Math.abs(tx.amount))}
                    </p>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </ScreenContainer>

      <Dialog open={showReceive} onOpenChange={setShowReceive}>
        <DialogContent className="max-w-sm rounded-2xl border-black/10">
          <DialogHeader>
            <DialogTitle>Recevoir de l'argent</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Partagez cet identifiant wallet pour recevoir un paiement.
            </p>
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-sm font-medium text-black">
              {wallet?.id ?? "wallet-introuvable"}
            </div>
            <Button
              className="w-full rounded-xl bg-black text-white hover:bg-black/90"
              onClick={async () => {
                if (!wallet?.id) return;
                await navigator.clipboard.writeText(wallet.id).catch(() => undefined);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
                toast({ title: "Identifiant copie", description: "Tu peux maintenant le partager." });
              }}
            >
              <Copy className="h-4 w-4" />
              {copied ? "Copie" : "Copier l'identifiant"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeposit} onOpenChange={setShowDeposit}>
        <DialogContent className="max-w-sm rounded-2xl border-black/10">
          <DialogHeader>
            <DialogTitle>Deposer sur mon wallet</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              inputMode="numeric"
              value={depositAmount}
              onChange={(event) => setDepositAmount(event.target.value)}
              placeholder="Montant en XOF"
              className="h-11 rounded-xl"
            />
            <Button
              className="press-feedback w-full rounded-xl bg-black text-white hover:bg-black/90"
              onClick={() => {
                if (depositMutation.isPending || pendingDepositConfirm || !depositCooldown.canRun("deposit")) return;
                setPendingDepositConfirm(true);
                trackUxAction("wallet.deposit.pending", { amount: Number(depositAmount), userId: user?.id ?? "anon" });
                depositMutation.mutate();
              }}
              disabled={depositMutation.isPending || pendingDepositConfirm}
            >
              {depositMutation.isPending || pendingDepositConfirm ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {depositMutation.isPending || pendingDepositConfirm ? "Transaction en cours..." : "Confirmer le depot"}
            </Button>
            {pendingDepositConfirm ? (
              <TrustPill state="processing" />
            ) : null}
            <p className="text-xs text-gray-500">
              Cette action enverra une demande de depot vers l'API wallet existante.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showSend} onOpenChange={setShowSend}>
        <DialogContent className="max-w-sm rounded-2xl border-black/10">
          <DialogHeader>
            <DialogTitle>Envoyer de l'argent</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={recipientWalletId}
              onChange={(event) => setRecipientWalletId(event.target.value)}
              placeholder="Identifiant wallet destinataire"
              className="h-11 rounded-xl"
            />
            <Input
              inputMode="numeric"
              value={sendAmount}
              onChange={(event) => setSendAmount(event.target.value)}
              placeholder="Montant en XOF"
              className="h-11 rounded-xl"
            />
            <Button
              className="press-feedback w-full rounded-xl bg-black text-white hover:bg-black/90"
              onClick={() => {
                if (sendMutation.isPending || pendingSendConfirm || !sendCooldown.canRun("send")) return;
                setPendingSendConfirm(true);
                trackUxAction("wallet.send.pending", { amount: Number(sendAmount), userId: user?.id ?? "anon" });
                sendMutation.mutate();
              }}
              disabled={sendMutation.isPending || pendingSendConfirm}
            >
              {sendMutation.isPending || pendingSendConfirm ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
              {sendMutation.isPending || pendingSendConfirm ? "Transaction en cours..." : "Confirmer l'envoi"}
            </Button>
            {pendingSendConfirm ? (
              <TrustPill state="processing" />
            ) : null}
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-500">
              <p className="font-medium text-gray-700">Retour visuel instantane</p>
              <p className="mt-0.5">Tu recevras une confirmation juste apres validation.</p>
            </div>
            {sendMutation.isSuccess ? (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                Envoi confirme.
              </div>
            ) : null}
            {typeof navigator !== "undefined" && !navigator.onLine ? (
              <TrustPill state="queued-offline" />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <div className="mx-auto mb-2 w-full max-w-4xl px-4">
        <div className="rounded-2xl border border-gray-100 bg-white px-4 py-3 text-xs text-gray-600">
          <div className="flex flex-wrap items-center gap-2">
            <TrustPill state={historyStatus} />
            <span>Chaque operation est verrouillee pour eviter le double clic et les executions en double.</span>
          </div>
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
