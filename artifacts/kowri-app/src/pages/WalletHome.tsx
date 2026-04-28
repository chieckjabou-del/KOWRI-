import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Copy, CreditCard, Landmark, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { formatXOF, relativeTime } from "@/lib/api";
import {
  depositToWallet,
  getPrimaryWallet,
  getWalletTransactions,
} from "@/services/api/walletService";
import { transactionDirection } from "@/features/wallet/wallet-ui";

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
  await fetch("/api/wallet/transfer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `${Date.now()}-wallet-send`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

export default function WalletHome() {
  const { token, user } = useAuth();
  const queryClient = useQueryClient();
  const [showReceive, setShowReceive] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState("50000");
  const [copied, setCopied] = useState(false);

  const walletQuery = useQuery({
    queryKey: ["akwe-wallet", user?.id],
    enabled: Boolean(user?.id),
    queryFn: () => getPrimaryWallet(token, user!.id),
  });

  const wallet = walletQuery.data?.wallet;
  const usingMockWallet = walletQuery.data?.usingMock ?? false;

  const transactionsQuery = useQuery({
    queryKey: ["akwe-wallet-transactions", wallet?.id],
    enabled: Boolean(wallet?.id),
    queryFn: () => getWalletTransactions(token, wallet!.id, 20),
  });

  const transactions = useMemo(
    () => transactionsQuery.data?.transactions ?? [],
    [transactionsQuery.data?.transactions],
  );
  const usingMockTransactions = transactionsQuery.data?.usingMock ?? false;

  const depositMutation = useMutation({
    mutationFn: async () => {
      if (!wallet) return;
      const amount = Number(depositAmount);
      if (!Number.isFinite(amount) || amount <= 0) return;
      await depositToWallet(token, wallet.id, amount);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet", user?.id] });
      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet-transactions", wallet?.id] });
      setShowDeposit(false);
    },
  });

  const loading = walletQuery.isLoading || !wallet;

  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <TopBar title="Wallet" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-5">
        {(usingMockWallet || usingMockTransactions) && (
          <div className="rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
            Mode simulation active: certaines donnees wallet sont affichees en fallback UI.
          </div>
        )}

        <Card className="rounded-3xl border-black/5 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Solde principal</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {loading ? (
              <div className="py-8 text-sm text-gray-500">Chargement du wallet...</div>
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
                    className="h-12 w-full rounded-xl bg-black text-white hover:bg-black/90"
                    onClick={async () => {
                      if (!wallet) return;
                      const recipient = prompt("Identifiant wallet destinataire");
                      if (!recipient) return;
                      const rawAmount = prompt("Montant a envoyer (XOF)");
                      const amount = Number(rawAmount ?? "0");
                      if (!Number.isFinite(amount) || amount <= 0) return;
                      await sendTransfer(token, {
                        fromWalletId: wallet.id,
                        toWalletId: recipient,
                        amount,
                        currency: "XOF",
                        description: "Transfert Wallet Akwé",
                      });
                      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet", user?.id] });
                      await queryClient.invalidateQueries({ queryKey: ["akwe-wallet-transactions", wallet.id] });
                    }}
                  >
                    Envoyer
                  </Button>
                  <Button
                    variant="outline"
                    className="h-12 rounded-xl"
                    onClick={() => setShowDeposit(true)}
                  >
                    Deposer
                  </Button>
                  <Button variant="outline" className="h-12 rounded-xl" onClick={() => setShowReceive(true)}>
                    Recevoir
                  </Button>
                  <Button variant="outline" className="h-12 rounded-xl" onClick={() => alert("Retrait bientot disponible")}>
                    Retirer
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <section className="grid gap-3 sm:grid-cols-2">
          <Card className="rounded-2xl border-black/5 shadow-sm">
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
          <Card className="rounded-2xl border-black/5 shadow-sm">
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

        <Card className="rounded-3xl border-black/5 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-semibold text-black">Historique des transactions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {transactionsQuery.isLoading ? (
              <div className="py-5 text-sm text-gray-500">Chargement des transactions...</div>
            ) : transactions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
                Aucune transaction pour le moment.
              </div>
            ) : (
              transactions.map((tx) => {
                const direction = transactionDirection(tx, wallet?.id ?? "");
                const incoming = direction === "incoming";
                return (
                  <div
                    key={tx.id}
                    className="flex items-center justify-between rounded-xl border border-gray-100 px-3 py-3"
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
      </main>

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
              className="w-full rounded-xl bg-black text-white hover:bg-black/90"
              onClick={() => depositMutation.mutate()}
              disabled={depositMutation.isPending}
            >
              {depositMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Confirmer le depot
            </Button>
            <p className="text-xs text-gray-500">
              Cette action enverra une demande de depot vers l'API wallet existante.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <BottomNav />
    </div>
  );
}
