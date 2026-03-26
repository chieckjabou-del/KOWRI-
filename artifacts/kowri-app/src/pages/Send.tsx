import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2 } from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

type Step = "form" | "confirm" | "success";

export default function Send() {
  const { token, user } = useAuth();
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>("form");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [txId, setTxId] = useState<string | null>(null);

  const walletsQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn: () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled: !!user?.id,
  });
  const wallet = walletsQ.data?.wallets?.[0] ?? null;

  const sendMut = useMutation({
    mutationFn: async () => {
      const data = await apiFetch<any>("/transactions/transfer", token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify({
          fromWalletId: wallet?.id,
          recipientPhone: recipientPhone.trim(),
          amount: parseFloat(amount),
          description: description.trim() || "Transfert P2P",
        }),
      });
      return data;
    },
    onSuccess: (data) => {
      setTxId(data?.transactionId ?? data?.id ?? null);
      setStep("success");
      qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
    onError: (err: any) => setError(err.message ?? "Transfert échoué"),
  });

  const amountNum = parseFloat(amount);
  const fee = isNaN(amountNum) ? 0 : Math.round(amountNum * 0.005 * 100) / 100;
  const total = isNaN(amountNum) ? 0 : amountNum + fee;
  const available = parseFloat(wallet?.availableBalance ?? "0");

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!recipientPhone.trim()) return setError("Numéro du destinataire requis");
    if (!amountNum || amountNum <= 0) return setError("Montant invalide");
    if (total > available) return setError("Solde insuffisant");
    setStep("confirm");
  }

  return (
    <div className="min-h-screen" style={{ background: "#FAFAF8" }}>
      {step === "success" ? (
        <div className="flex flex-col items-center justify-center min-h-screen pb-20 px-6">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center mb-6"
            style={{ background: "#F0FDF4" }}
          >
            <CheckCircle2 size={40} style={{ color: "#1A6B32" }} />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Envoi réussi !</h2>
          <p className="text-gray-500 text-center text-sm mb-2">
            {formatXOF(amountNum)} envoyés à <strong>{recipientPhone}</strong>
          </p>
          {txId && <p className="text-xs text-gray-400 mb-8">Réf: {txId}</p>}
          <button
            onClick={() => { setStep("form"); setAmount(""); setRecipientPhone(""); setDescription(""); }}
            className="w-full max-w-xs py-4 rounded-2xl font-bold text-white text-base"
            style={{ background: "#1A6B32" }}
          >
            Nouveau transfert
          </button>
          <button
            onClick={() => navigate("/dashboard")}
            className="mt-3 w-full max-w-xs py-4 rounded-2xl font-semibold text-gray-700 text-base border border-gray-200 bg-white"
          >
            Retour à l'accueil
          </button>
          <BottomNav />
        </div>
      ) : (
        <div className="pb-20">
      <TopBar title="Envoyer" showBack onBack={() => step === "confirm" ? setStep("form") : navigate("/dashboard")} />

      <main className="px-4 pt-5 max-w-lg mx-auto">
        {/* Balance pill */}
        {wallet && (
          <div className="mb-5 px-4 py-3 rounded-2xl flex items-center justify-between" style={{ background: "#F0FDF4" }}>
            <span className="text-sm text-gray-600">Solde disponible</span>
            <span className="font-bold text-sm" style={{ color: "#1A6B32" }}>{formatXOF(available)}</span>
          </div>
        )}

        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
            {error}
          </div>
        )}

        {step === "form" && (
          <form onSubmit={handleFormSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Téléphone du destinataire</label>
              <input
                type="tel"
                value={recipientPhone}
                onChange={e => setRecipientPhone(e.target.value)}
                placeholder="+226 70 00 00 00"
                inputMode="tel"
                className="w-full px-4 py-3.5 rounded-2xl border border-gray-200 bg-white text-gray-900 text-base focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ minHeight: 52 }}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Montant (FCFA)</label>
              <div className="relative">
                <input
                  type="number"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0"
                  inputMode="decimal"
                  className="w-full px-4 py-3.5 rounded-2xl border border-gray-200 bg-white text-gray-900 text-base focus:outline-none focus:ring-2 focus:border-transparent pr-20"
                  style={{ minHeight: 52 }}
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-medium">XOF</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Motif (optionnel)</label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Ex: Loyer Janvier"
                className="w-full px-4 py-3.5 rounded-2xl border border-gray-200 bg-white text-gray-900 text-base focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ minHeight: 52 }}
              />
            </div>

            {amountNum > 0 && (
              <div className="rounded-2xl p-4 space-y-2 border border-gray-100 bg-white">
                <div className="flex justify-between text-sm text-gray-500">
                  <span>Montant</span><span className="text-gray-900 font-medium">{formatXOF(amountNum)}</span>
                </div>
                <div className="flex justify-between text-sm text-gray-500">
                  <span>Frais (0.5%)</span><span className="text-gray-900 font-medium">{formatXOF(fee)}</span>
                </div>
                <div className="border-t border-gray-100 pt-2 flex justify-between text-sm font-bold text-gray-900">
                  <span>Total</span><span>{formatXOF(total)}</span>
                </div>
              </div>
            )}

            <button
              type="submit"
              className="w-full py-4 rounded-2xl font-bold text-white text-base"
              style={{ background: "#1A6B32", minHeight: 52 }}
            >
              Continuer
            </button>
          </form>
        )}

        {step === "confirm" && (
          <div className="space-y-5">
            <div className="text-center py-4">
              <p className="text-4xl font-black text-gray-900 mb-1">{formatXOF(amountNum)}</p>
              <p className="text-gray-500 text-sm">vers <strong>{recipientPhone}</strong></p>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-gray-100 space-y-3">
              <Row label="Destinataire" value={recipientPhone} />
              <Row label="Montant" value={formatXOF(amountNum)} />
              <Row label="Frais" value={formatXOF(fee)} />
              <Row label="Total débité" value={formatXOF(total)} bold />
              {description && <Row label="Motif" value={description} />}
            </div>

            <p className="text-xs text-center text-gray-400">
              Ce transfert est immédiat et irrévocable.
            </p>

            <button
              onClick={() => sendMut.mutate()}
              disabled={sendMut.isPending}
              className="w-full py-4 rounded-2xl font-bold text-white text-base flex items-center justify-center gap-2 disabled:opacity-70"
              style={{ background: "#1A6B32", minHeight: 52 }}
            >
              {sendMut.isPending ? <Loader2 size={18} className="animate-spin" /> : null}
              Confirmer et envoyer
            </button>
          </div>
        )}
      </main>

          <BottomNav />
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className={bold ? "font-bold text-gray-900" : "font-medium text-gray-900"}>{value}</span>
    </div>
  );
}
