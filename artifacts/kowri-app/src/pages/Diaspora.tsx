import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Plus, X, Loader2, CheckCircle2, Globe, Repeat, Send,
  Pause, Play, ChevronRight,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

/* ─── Data helpers ─────────────────────────────────────────────────────── */
const CURRENCY_FLAG: Record<string, string> = {
  XOF: "🌍", GHS: "🇬🇭", NGN: "🇳🇬", KES: "🇰🇪", TZS: "🇹🇿",
  GBP: "🇬🇧", EUR: "🇫🇷", USD: "🇺🇸", MAD: "🇲🇦", ZAR: "🇿🇦",
  EGP: "🇪🇬", ETB: "🇪🇹", RWF: "🇷🇼",
};

const COUNTRY_FLAG: Record<string, string> = {
  GH: "🇬🇭", NG: "🇳🇬", SN: "🇸🇳", CI: "🇨🇮", KE: "🇰🇪", TZ: "🇹🇿",
  UK: "🇬🇧", GB: "🇬🇧", FR: "🇫🇷", US: "🇺🇸", BF: "🇧🇫", ML: "🇲🇱",
  CM: "🇨🇲", RW: "🇷🇼", ZA: "🇿🇦", EG: "🇪🇬", ET: "🇪🇹", MA: "🇲🇦",
};

const FREQ_LABELS: Record<string, string> = {
  weekly: "Hebdo", biweekly: "Bimensuel", monthly: "Mensuel",
};

function initials(name: string) {
  return name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

/* ─── Types ────────────────────────────────────────────────────────────── */
interface Corridor { id: string; fromCurrency: string; toCurrency: string; fromCountry?: string; toCountry?: string; estimatedMins?: number; flatFee?: number; percentFee?: number; }
interface Beneficiary { id: string; name: string; country: string; phone?: string; walletId?: string; currency?: string; relationship?: string; }
interface Quote { corridorId?: string; fee: number; totalDebit: number; estimatedMins?: number; toCurrency: string; sendAmount: number; }

/* ─── Main page ─────────────────────────────────────────────────────────── */
export default function Diaspora() {
  const { token, user } = useAuth();
  const qc = useQueryClient();

  const [tab, setTab] = useState<"send" | "recurring">("send");

  /* Transfer form state */
  const [selectedBene, setSelectedBene]       = useState<Beneficiary | null>(null);
  const [selectedCorr, setSelectedCorr]       = useState<Corridor | null>(null);
  const [transferStep, setTransferStep]       = useState<"idle" | "amount" | "confirm" | "success">("idle");
  const [formAmount, setFormAmount]           = useState("");
  const [quote, setQuote]                     = useState<Quote | null>(null);
  const [quoteLoading, setQuoteLoading]       = useState(false);
  const [sendError, setSendError]             = useState("");
  const [txRef, setTxRef]                     = useState("");
  const debounceRef                           = useRef<ReturnType<typeof setTimeout>>(null);

  /* Modals */
  const [showAddBene, setShowAddBene]           = useState(false);
  const [showAddRecurring, setShowAddRecurring] = useState(false);
  const [beneForm, setBeneForm]                 = useState({ name: "", country: "", phone: "", relationship: "family" });
  const [beneError, setBeneError]               = useState("");
  const [recurForm, setRecurForm]               = useState({ beneficiaryId: "", amount: "", frequency: "monthly" });
  const [recurError, setRecurError]             = useState("");

  /* Wallet */
  const walletsQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn: () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled: !!user?.id,
  });
  const wallet = walletsQ.data?.wallets?.[0] ?? null;
  const available = parseFloat(wallet?.availableBalance ?? "0");

  /* Corridors */
  const corridorsQ = useQuery({
    queryKey: ["corridors"],
    queryFn: () => apiFetch<any>("/diaspora/corridors", token),
    staleTime: 60_000,
  });
  const corridors: Corridor[] = corridorsQ.data?.corridors ?? [];

  /* Beneficiaries */
  const beneQ = useQuery({
    queryKey: ["beneficiaries", user?.id],
    queryFn: () => apiFetch<any>(`/diaspora/beneficiaries?userId=${user?.id}`, token),
    enabled: !!user?.id,
    staleTime: 30_000,
  });
  const beneficiaries: Beneficiary[] = beneQ.data?.beneficiaries ?? [];

  /* Recurring */
  const recurQ = useQuery({
    queryKey: ["recurring", user?.id],
    queryFn: () => apiFetch<any>(`/diaspora/recurring?userId=${user?.id}`, token),
    enabled: !!user?.id && tab === "recurring",
    staleTime: 30_000,
  });
  const recurring = recurQ.data?.recurring ?? [];

  /* Live quote: debounce on amount change */
  useEffect(() => {
    if (!formAmount || !selectedCorr) { setQuote(null); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setQuoteLoading(true);
      try {
        const data = await apiFetch<any>("/diaspora/quote", token, {
          method: "POST",
          body: JSON.stringify({
            amount: parseFloat(formAmount),
            fromCurrency: selectedCorr.fromCurrency,
            toCurrency: selectedCorr.toCurrency,
          }),
        });
        setQuote(data.bestQuote ?? null);
      } catch { setQuote(null); }
      finally { setQuoteLoading(false); }
    }, 400);
  }, [formAmount, selectedCorr]);

  /* Mutations */
  const addBeneMut = useMutation({
    mutationFn: () => apiFetch<any>("/diaspora/beneficiaries", token, {
      method: "POST",
      body: JSON.stringify({ userId: user?.id, ...beneForm, currency: "XOF" }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["beneficiaries", user?.id] });
      setShowAddBene(false);
      setBeneForm({ name: "", country: "", phone: "", relationship: "family" });
      setBeneError("");
    },
    onError: (e: any) => setBeneError(e.message ?? "Erreur"),
  });

  const sendMut = useMutation({
    mutationFn: () => {
      if (!wallet || !selectedBene || !selectedCorr) throw new Error("Données manquantes");
      return apiFetch<any>("/diaspora/send", token, {
        method: "POST",
        body: JSON.stringify({
          fromWalletId: wallet.id,
          senderUserId: user?.id,
          beneficiaryId: selectedBene.id,
          amount: parseFloat(formAmount),
          fromCurrency: selectedCorr.fromCurrency,
          toCurrency: selectedCorr.toCurrency,
          description: `Transfert diaspora → ${selectedBene.name}`,
        }),
      });
    },
    onSuccess: (data) => {
      setTxRef(data?.transactionId ?? data?.id ?? generateIdempotencyKey());
      setTransferStep("success");
      qc.invalidateQueries({ queryKey: ["wallets", user?.id] });
    },
    onError: (e: any) => setSendError(e.message ?? "Transfert échoué"),
  });

  const pauseResumeMut = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" }) =>
      apiFetch<any>(`/diaspora/recurring/${id}/${action}`, token, { method: "PATCH" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring", user?.id] }),
  });

  const addRecurMut = useMutation({
    mutationFn: () => {
      if (!wallet) throw new Error("Wallet requis");
      return apiFetch<any>("/diaspora/recurring", token, {
        method: "POST",
        body: JSON.stringify({
          userId: user?.id,
          fromWalletId: wallet.id,
          beneficiaryId: recurForm.beneficiaryId,
          amount: parseFloat(recurForm.amount),
          currency: "XOF",
          frequency: recurForm.frequency,
          description: "Virement diaspora récurrent",
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recurring", user?.id] });
      setShowAddRecurring(false);
      setRecurForm({ beneficiaryId: "", amount: "", frequency: "monthly" });
      setRecurError("");
    },
    onError: (e: any) => setRecurError(e.message ?? "Erreur"),
  });

  /* Handlers */
  function selectCorridor(c: Corridor) {
    setSelectedCorr(c);
    if (transferStep === "idle") setTransferStep("amount");
  }

  function selectBeneficiary(b: Beneficiary) {
    setSelectedBene(b);
    setTransferStep("amount");
  }

  function resetTransfer() {
    setTransferStep("idle");
    setSelectedBene(null);
    setSelectedCorr(null);
    setFormAmount("");
    setQuote(null);
    setSendError("");
    setTxRef("");
  }

  /* ─── Render ──────────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar title="Diaspora" />

      {/* Tab bar */}
      <div className="sticky top-14 z-30 bg-white border-b border-gray-100 flex">
        {([["send", <Globe size={14} />, "Envoyer"], ["recurring", <Repeat size={14} />, "Récurrents"]] as const).map(([t, icon, label]) => (
          <button
            key={t}
            onClick={() => setTab(t as any)}
            className="flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-semibold border-b-2 transition-colors"
            style={{
              borderColor: tab === t ? "#1A6B32" : "transparent",
              color: tab === t ? "#1A6B32" : "#9CA3AF",
            }}
          >
            {icon} {label}
          </button>
        ))}
      </div>

      <main className="px-4 pt-5 pb-4 max-w-lg mx-auto space-y-5">

        {/* Merchant link */}
        <Link href="/merchant">
          <div className="flex items-center justify-between px-4 py-3 rounded-2xl bg-white border border-gray-100 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="text-xl">🏪</span>
              <div>
                <p className="text-sm font-semibold text-gray-900">Compte Marchand</p>
                <p className="text-xs text-gray-500">QR code, paiements, revenus</p>
              </div>
            </div>
            <ChevronRight size={16} className="text-gray-400" />
          </div>
        </Link>

        {/* ─── TAB: ENVOYER ─────────────────────────────────────────── */}
        {tab === "send" && (
          <>
            {/* Transfer success */}
            {transferStep === "success" && (
              <div className="bg-white rounded-3xl p-8 text-center shadow-sm border border-gray-100">
                <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F0FDF4" }}>
                  <CheckCircle2 size={32} style={{ color: "#1A6B32" }} />
                </div>
                <h2 className="text-xl font-bold text-gray-900 mb-1">Transfert envoyé !</h2>
                <p className="text-sm text-gray-500 mb-1">
                  {formatXOF(parseFloat(formAmount))} → <strong>{selectedBene?.name}</strong>
                </p>
                {txRef && <p className="text-xs text-gray-400 mb-6">Réf: {txRef}</p>}
                <button
                  onClick={resetTransfer}
                  className="w-full py-3 rounded-2xl font-bold text-white"
                  style={{ background: "#1A6B32" }}
                >
                  Nouveau transfert
                </button>
              </div>
            )}

            {transferStep !== "success" && (
              <>
                {/* Corridors */}
                <section>
                  <h2 className="font-bold text-gray-900 text-sm mb-3">Corridors disponibles</h2>
                  {corridorsQ.isLoading ? (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {[0,1,2,3].map(i => <div key={i} className="flex-shrink-0 h-9 w-28 bg-gray-100 rounded-full animate-pulse" />)}
                    </div>
                  ) : (
                    <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
                      {corridors.map(c => {
                        const active = selectedCorr?.id === c.id;
                        return (
                          <button
                            key={c.id}
                            onClick={() => selectCorridor(c)}
                            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold border transition-all"
                            style={{
                              background: active ? "#F0FDF4" : "white",
                              borderColor: active ? "#1A6B32" : "#E5E7EB",
                              color: active ? "#1A6B32" : "#6B7280",
                            }}
                          >
                            <span>{CURRENCY_FLAG[c.fromCurrency] ?? "🌍"}</span>
                            <span>{c.fromCurrency}→{c.toCurrency}</span>
                            <span>{CURRENCY_FLAG[c.toCurrency] ?? "🌍"}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* Beneficiaries */}
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-bold text-gray-900 text-sm">Mes Bénéficiaires</h2>
                    <button
                      onClick={() => setShowAddBene(true)}
                      className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-xl"
                      style={{ background: "#F0FDF4", color: "#1A6B32", minHeight: 32 }}
                    >
                      <Plus size={12} /> Ajouter
                    </button>
                  </div>

                  {beneQ.isLoading ? (
                    <div className="space-y-2">
                      {[0,1].map(i => <div key={i} className="h-16 bg-white rounded-2xl animate-pulse border border-gray-100" />)}
                    </div>
                  ) : beneficiaries.length === 0 ? (
                    <div className="bg-white rounded-2xl p-5 text-center border border-gray-100">
                      <p className="text-sm text-gray-500 mb-3">Aucun bénéficiaire — Ajoutez-en un</p>
                      <button
                        onClick={() => setShowAddBene(true)}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-xl"
                        style={{ background: "#1A6B32", color: "white", minHeight: 36 }}
                      >
                        <Plus size={13} /> Ajouter un bénéficiaire
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {beneficiaries.map(b => (
                        <div key={b.id} className="bg-white rounded-2xl px-4 py-3 border border-gray-100 flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
                            style={{ background: "#1A6B32" }}
                          >
                            {initials(b.name)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-gray-900 truncate">
                              {COUNTRY_FLAG[b.country] ?? "🌍"} {b.name}
                            </p>
                            <p className="text-xs text-gray-500 truncate">{b.phone ?? b.walletId ?? b.country}</p>
                          </div>
                          <button
                            onClick={() => selectBeneficiary(b)}
                            className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-xl flex-shrink-0"
                            style={{ background: "#F0FDF4", color: "#1A6B32", minHeight: 32 }}
                          >
                            <Send size={11} /> Envoyer
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Transfer form */}
                {(transferStep === "amount" || transferStep === "confirm") && selectedBene && selectedCorr && (
                  <section>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="font-bold text-gray-900 text-sm">
                        Nouveau transfert → {selectedBene.name}
                      </h2>
                      <button onClick={resetTransfer} className="text-gray-400 hover:text-gray-600">
                        <X size={16} />
                      </button>
                    </div>

                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                      {transferStep === "amount" && (
                        <div className="p-4 space-y-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1.5">
                              Montant ({selectedCorr.fromCurrency})
                            </label>
                            <div className="relative">
                              <input
                                type="number"
                                value={formAmount}
                                onChange={e => setFormAmount(e.target.value)}
                                placeholder="0"
                                inputMode="decimal"
                                className="w-full px-4 py-3.5 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-base focus:outline-none pr-16"
                                style={{ minHeight: 52 }}
                              />
                              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-400">
                                {selectedCorr.fromCurrency}
                              </span>
                            </div>
                            <p className="text-xs text-gray-400 mt-1">Disponible: {formatXOF(available)}</p>
                          </div>

                          {/* Live quote */}
                          {quoteLoading && (
                            <div className="flex items-center gap-2 text-xs text-gray-500">
                              <Loader2 size={12} className="animate-spin" /> Calcul du taux...
                            </div>
                          )}
                          {quote && !quoteLoading && (
                            <div className="rounded-xl p-3 space-y-2 border border-gray-100" style={{ background: "#F9FAFB" }}>
                              <QuoteRow label="Frais fixes" value={formatXOF(quote.fee)} />
                              <QuoteRow label="Ils reçoivent" value={`${(quote.sendAmount - quote.fee).toFixed(2)} ${quote.toCurrency}`} bold green />
                              <QuoteRow label="Total débité" value={formatXOF(quote.totalDebit)} bold />
                              {quote.estimatedMins && (
                                <QuoteRow label="Délai estimé" value={`~${quote.estimatedMins} min`} />
                              )}
                            </div>
                          )}

                          <button
                            onClick={() => setTransferStep("confirm")}
                            disabled={!formAmount || !quote}
                            className="w-full py-4 rounded-xl font-bold text-white text-sm disabled:opacity-60"
                            style={{ background: "#1A6B32", minHeight: 52 }}
                          >
                            Continuer
                          </button>
                        </div>
                      )}

                      {transferStep === "confirm" && (
                        <div className="p-4 space-y-4">
                          <div className="text-center py-2">
                            <p className="text-3xl font-black text-gray-900">{formAmount} {selectedCorr.fromCurrency}</p>
                            <p className="text-gray-500 text-sm mt-1">
                              vers <strong>{selectedBene.name}</strong>{" "}
                              {COUNTRY_FLAG[selectedBene.country] ?? ""}
                            </p>
                          </div>

                          {quote && (
                            <div className="rounded-xl p-3 space-y-2 border border-gray-100" style={{ background: "#F9FAFB" }}>
                              <QuoteRow label="Ils reçoivent" value={`${(parseFloat(formAmount) - quote.fee).toFixed(2)} ${quote.toCurrency}`} bold green />
                              <QuoteRow label="Frais" value={formatXOF(quote.fee)} />
                              <QuoteRow label="Total débité" value={formatXOF(quote.totalDebit)} bold />
                            </div>
                          )}

                          {sendError && (
                            <div className="px-4 py-3 rounded-xl text-sm" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                              {sendError}
                            </div>
                          )}

                          <button
                            onClick={() => sendMut.mutate()}
                            disabled={sendMut.isPending}
                            className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
                            style={{ background: "#1A6B32", minHeight: 52 }}
                          >
                            {sendMut.isPending && <Loader2 size={16} className="animate-spin" />}
                            Confirmer le transfert
                          </button>
                          <button
                            onClick={() => setTransferStep("amount")}
                            className="w-full py-3 text-sm text-gray-500"
                          >
                            Modifier
                          </button>
                        </div>
                      )}
                    </div>
                  </section>
                )}

                {/* CTA when no corridor/bene selected */}
                {transferStep === "idle" && corridors.length > 0 && (
                  <div className="bg-white rounded-2xl p-5 border border-dashed border-gray-200 text-center">
                    <p className="text-sm text-gray-500">
                      Sélectionnez un corridor et un bénéficiaire pour envoyer de l'argent
                    </p>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ─── TAB: RÉCURRENTS ──────────────────────────────────────── */}
        {tab === "recurring" && (
          <>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-gray-900 text-base">Virements récurrents</h2>
              <button
                onClick={() => setShowAddRecurring(true)}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl"
                style={{ background: "#1A6B32", color: "white", minHeight: 36 }}
              >
                <Plus size={13} /> Programmer
              </button>
            </div>

            {recurQ.isLoading && (
              <div className="space-y-3">
                {[0,1].map(i => <div key={i} className="h-20 bg-white rounded-2xl animate-pulse border border-gray-100" />)}
              </div>
            )}

            {!recurQ.isLoading && recurring.length === 0 && (
              <div className="bg-white rounded-2xl p-8 text-center border border-gray-100 shadow-sm">
                <p className="text-3xl mb-3">🔄</p>
                <p className="font-semibold text-gray-900 mb-1">Aucun virement programmé</p>
                <p className="text-sm text-gray-500 mb-5">
                  Automatisez vos transferts réguliers vers vos proches
                </p>
                <button
                  onClick={() => setShowAddRecurring(true)}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-bold text-white text-sm"
                  style={{ background: "#1A6B32" }}
                >
                  <Plus size={15} /> Programmer un virement
                </button>
              </div>
            )}

            <div className="space-y-3">
              {recurring.map((r: any) => {
                const bene = beneficiaries.find(b => b.id === r.beneficiaryId);
                const isActive = r.status === "active";
                return (
                  <div key={r.id} className="bg-white rounded-2xl px-4 py-4 border border-gray-100 shadow-sm">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <p className="text-sm font-semibold text-gray-900">
                          {bene ? `${COUNTRY_FLAG[bene.country] ?? "🌍"} ${bene.name}` : "Bénéficiaire"}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {formatXOF(r.amount)} · {FREQ_LABELS[r.frequency] ?? r.frequency}
                        </p>
                        {r.nextRunAt && (
                          <p className="text-xs text-gray-400 mt-0.5">
                            Prochain: {new Date(r.nextRunAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className="text-xs px-2 py-0.5 rounded-full font-medium"
                          style={isActive
                            ? { background: "#F0FDF4", color: "#16A34A" }
                            : { background: "#FFFBEB", color: "#D97706" }
                          }
                        >
                          {isActive ? "ACTIF" : "PAUSÉ"}
                        </span>
                        <button
                          onClick={() => pauseResumeMut.mutate({ id: r.id, action: isActive ? "pause" : "resume" })}
                          disabled={pauseResumeMut.isPending}
                          className="w-8 h-8 rounded-full flex items-center justify-center border border-gray-200 hover:bg-gray-50"
                        >
                          {isActive
                            ? <Pause size={13} className="text-gray-500" />
                            : <Play size={13} className="text-gray-500" />
                          }
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </main>

      <BottomNav />

      {/* ─── Add beneficiary modal ──────────────────────────────────── */}
      {showAddBene && (
        <Modal title="Nouveau Bénéficiaire" onClose={() => setShowAddBene(false)}>
          {beneError && <ErrorBox msg={beneError} />}
          <form onSubmit={e => { e.preventDefault(); setBeneError(""); addBeneMut.mutate(); }} className="space-y-4">
            <Field label="Nom complet">
              <input type="text" value={beneForm.name}
                onChange={e => setBeneForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Ex: Moussa Traoré" className={INPUT_CLS} style={{ minHeight: 48 }} />
            </Field>
            <Field label="Pays">
              <input type="text" value={beneForm.country}
                onChange={e => setBeneForm(f => ({ ...f, country: e.target.value.toUpperCase().slice(0, 2) }))}
                placeholder="Ex: GH, NG, SN, KE" maxLength={2}
                className={INPUT_CLS} style={{ minHeight: 48 }} />
            </Field>
            <Field label="Téléphone">
              <input type="tel" value={beneForm.phone}
                onChange={e => setBeneForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="+233 00 000 000" inputMode="tel"
                className={INPUT_CLS} style={{ minHeight: 48 }} />
            </Field>
            <Field label="Relation">
              <select value={beneForm.relationship}
                onChange={e => setBeneForm(f => ({ ...f, relationship: e.target.value }))}
                className={INPUT_CLS} style={{ minHeight: 48 }}>
                {[["family", "Famille"], ["friend", "Ami(e)"], ["business", "Professionnel"], ["other", "Autre"]].map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </Field>
            <SubmitBtn loading={addBeneMut.isPending}>Ajouter</SubmitBtn>
          </form>
        </Modal>
      )}

      {/* ─── Schedule recurring modal ───────────────────────────────── */}
      {showAddRecurring && (
        <Modal title="Programmer un virement" onClose={() => setShowAddRecurring(false)}>
          {recurError && <ErrorBox msg={recurError} />}
          <form onSubmit={e => { e.preventDefault(); setRecurError(""); addRecurMut.mutate(); }} className="space-y-4">
            <Field label="Bénéficiaire">
              <select value={recurForm.beneficiaryId}
                onChange={e => setRecurForm(f => ({ ...f, beneficiaryId: e.target.value }))}
                className={INPUT_CLS} style={{ minHeight: 48 }}>
                <option value="">Choisir...</option>
                {beneficiaries.map(b => (
                  <option key={b.id} value={b.id}>{b.name} ({b.country})</option>
                ))}
              </select>
            </Field>
            <Field label="Montant (XOF)">
              <input type="number" value={recurForm.amount}
                onChange={e => setRecurForm(f => ({ ...f, amount: e.target.value }))}
                placeholder="5 000" inputMode="decimal"
                className={INPUT_CLS} style={{ minHeight: 48 }} />
            </Field>
            <Field label="Fréquence">
              <div className="grid grid-cols-3 gap-2">
                {[["weekly", "Hebdo"], ["biweekly", "Bimens."], ["monthly", "Mensuel"]].map(([v, l]) => (
                  <button key={v} type="button"
                    onClick={() => setRecurForm(f => ({ ...f, frequency: v }))}
                    className="py-3 rounded-xl text-xs font-semibold border transition-all"
                    style={{
                      background: recurForm.frequency === v ? "#F0FDF4" : "#F9FAFB",
                      borderColor: recurForm.frequency === v ? "#1A6B32" : "#E5E7EB",
                      color: recurForm.frequency === v ? "#1A6B32" : "#6B7280",
                      minHeight: 44,
                    }}>{l}</button>
                ))}
              </div>
            </Field>
            <SubmitBtn loading={addRecurMut.isPending}>Programmer</SubmitBtn>
          </form>
        </Modal>
      )}
    </div>
  );
}

/* ─── Shared micro-components ───────────────────────────────────────────── */
const INPUT_CLS = "w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function SubmitBtn({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  return (
    <button type="submit" disabled={loading}
      className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
      style={{ background: "#1A6B32", minHeight: 52 }}>
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pb-8 max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold text-gray-900">{title}</h2>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
            <X size={20} className="text-gray-500" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="mb-4 px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
      {msg}
    </div>
  );
}

function QuoteRow({ label, value, bold, green }: { label: string; value: string; bold?: boolean; green?: boolean }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span style={{ color: green ? "#16A34A" : undefined }}
        className={bold ? "font-bold text-gray-900" : "text-gray-700"}>{value}</span>
    </div>
  );
}
