import { useEffect, useMemo, useState } from "react";
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
    writeCache(cacheKey, walletQuery.data, { ttlMs: 3 * 60 * 1000 });
  }, [cacheKey, walletQuery.data]);

  useEffect(() => {
    if (!cacheKey || !transactionsQuery.data) return;
    setTxSeeded(transactionsQuery.data);
    writeCache(`${cacheKey}:tx`, transactionsQuery.data, { ttlMs: 90 * 1000 });
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
      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet", user?.id] });
      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet-transactions", wallet?.id] });
      setShowDeposit(false);
      toast({
        title: "Depot enregistre",
        description: "Le wallet a recu ta demande de depot.",
      });
    },
    onError: (error: unknown) => {
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
      toast({
        variant: "destructive",
        title: "Transfert bloque",
        description: error instanceof Error ? error.message : "Verifie les informations et reessaie.",
      });
    },
  });

  const loading = walletQuery.isLoading || !wallet;

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
                  <p className="text-4xl font-black tracking-tight text-black">
                    {formatXOF(wallet.availableBalance)}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Solde total: {formatXOF(wallet.balance)} - Statut: {wallet.status}
                  </p>
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
              onClick={() => depositMutation.mutate()}
              disabled={depositMutation.isPending}
            >
              {depositMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {depositMutation.isPending ? "Traitement..." : "Confirmer le depot"}
            </Button>
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
              onClick={() => sendMutation.mutate()}
              disabled={sendMutation.isPending}
            >
              {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
              {sendMutation.isPending ? "Envoi en cours..." : "Confirmer l'envoi"}
            </Button>
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
          </div>
        </DialogContent>
      </Dialog>

      <BottomNav />
    </div>
  );
}
