import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Loader2, Download, Share2, CheckCircle2, Store, ChevronLeft } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

/* ─── Helpers ──────────────────────────────────────────────────────────── */
const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  active:           { label: "Actif",          bg: "#F0FDF4", color: "#16A34A" },
  pending_approval: { label: "En validation",  bg: "#FFFBEB", color: "#D97706" },
  suspended:        { label: "Suspendu",        bg: "#FEF2F2", color: "#DC2626" },
};

const BUSINESS_TYPES = [
  "retail", "food", "services", "transport", "health",
  "education", "agriculture", "technology", "other",
];

const TYPE_LABELS: Record<string, string> = {
  retail: "Commerce", food: "Restauration", services: "Services",
  transport: "Transport", health: "Santé", education: "Éducation",
  agriculture: "Agriculture", technology: "Technologie", other: "Autre",
};

/* ─── Onboarding card ──────────────────────────────────────────────────── */
function Onboarding({ userId, onCreated }: { userId: string; onCreated: () => void }) {
  const { token } = useAuth();
  const [form, setForm] = useState({ businessName: "", businessType: "retail", country: "" });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const createMut = useMutation({
    mutationFn: () => apiFetch<any>("/merchants", token, {
      method: "POST",
      body: JSON.stringify({ userId, ...form }),
    }),
    onSuccess: () => { setSuccess(true); setTimeout(onCreated, 1200); },
    onError: (e: any) => setError(e.message ?? "Erreur lors de la création"),
  });

  if (success) {
    return (
      <div className="bg-white rounded-3xl p-8 text-center shadow-sm border border-gray-100">
        <CheckCircle2 size={40} style={{ color: "#1A6B32" }} className="mx-auto mb-4" />
        <p className="font-bold text-gray-900 text-lg">Compte créé !</p>
        <p className="text-sm text-gray-500 mt-1">Chargement de votre espace marchand...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Benefits */}
      <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl" style={{ background: "#F0FDF4" }}>
            🏪
          </div>
          <div>
            <h2 className="font-bold text-gray-900">Devenir Marchand KOWRI</h2>
            <p className="text-xs text-gray-500">Gratuit · Activé en quelques minutes</p>
          </div>
        </div>

        <div className="space-y-3 mb-6">
          {[
            ["💳", "Acceptez les paiements par QR code"],
            ["📊", "Suivez vos revenus en temps réel"],
            ["🔗", "Intégrez KOWRI dans votre boutique"],
          ].map(([icon, text]) => (
            <div key={text} className="flex items-center gap-3">
              <span className="text-xl">{icon}</span>
              <p className="text-sm text-gray-700">{text}</p>
            </div>
          ))}
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl text-sm" style={{ background: "#FEF2F2", color: "#DC2626" }}>
            {error}
          </div>
        )}

        <form onSubmit={e => { e.preventDefault(); setError(""); createMut.mutate(); }} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Nom de l'entreprise</label>
            <input
              type="text"
              value={form.businessName}
              onChange={e => setForm(f => ({ ...f, businessName: e.target.value }))}
              placeholder="Ex: Boutique Fatou"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none"
              style={{ minHeight: 48 }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Type d'activité</label>
            <div className="grid grid-cols-3 gap-2">
              {BUSINESS_TYPES.slice(0, 6).map(t => (
                <button key={t} type="button"
                  onClick={() => setForm(f => ({ ...f, businessType: t }))}
                  className="py-2.5 rounded-xl text-xs font-semibold border transition-all"
                  style={{
                    background: form.businessType === t ? "#F0FDF4" : "#F9FAFB",
                    borderColor: form.businessType === t ? "#1A6B32" : "#E5E7EB",
                    color: form.businessType === t ? "#1A6B32" : "#6B7280",
                    minHeight: 40,
                  }}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Pays</label>
            <input
              type="text"
              value={form.country}
              onChange={e => setForm(f => ({ ...f, country: e.target.value.toUpperCase().slice(0, 2) }))}
              placeholder="Ex: CI, SN, GH, BF"
              maxLength={2}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none"
              style={{ minHeight: 48 }}
            />
          </div>

          <button
            type="submit"
            disabled={createMut.isPending || !form.businessName || !form.country}
            className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-70"
            style={{ background: "#1A6B32", minHeight: 52 }}
          >
            {createMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
            Créer mon compte marchand
          </button>
        </form>
      </div>
    </div>
  );
}

/* ─── QR section ────────────────────────────────────────────────────────── */
function QRSection({ merchantId, businessName }: { merchantId: string; businessName: string }) {
  const qrValue = `kowri://pay?merchant=${merchantId}&currency=XOF`;
  const shareLink = `https://pay.kowri.io/${merchantId}`;
  const qrRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  function downloadQR() {
    const svg = qrRef.current?.querySelector("svg");
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 256, 256);
      ctx.drawImage(img, 0, 0, 256, 256);
      const link = document.createElement("a");
      link.download = `kowri-${merchantId}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
  }

  function copyLink() {
    navigator.clipboard.writeText(shareLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
      <h2 className="font-bold text-gray-900 mb-4 text-sm">Mon QR Code de paiement</h2>
      <div className="flex flex-col items-center">
        <div
          ref={qrRef}
          className="p-4 bg-white rounded-2xl border border-gray-100 shadow-sm mb-4"
        >
          <QRCodeSVG
            value={qrValue}
            size={180}
            level="H"
            includeMargin={false}
          />
        </div>

        <p className="text-xs text-gray-500 text-center mb-4 px-4 leading-relaxed">
          Faites scanner ce code par vos clients pour recevoir des paiements KOWRI
        </p>

        <div className="flex gap-3 w-full">
          <button
            onClick={downloadQR}
            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm border border-gray-200 bg-gray-50 text-gray-700"
            style={{ minHeight: 44 }}
          >
            <Download size={16} />
            Télécharger
          </button>
          <button
            onClick={copyLink}
            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm text-white"
            style={{ background: copied ? "#10B981" : "#1A6B32", minHeight: 44 }}
          >
            {copied ? <CheckCircle2 size={16} /> : <Share2 size={16} />}
            {copied ? "Copié !" : "Partager"}
          </button>
        </div>

        <p className="text-xs text-gray-400 mt-3 text-center break-all">{shareLink}</p>
      </div>
    </div>
  );
}

/* ─── Main page ─────────────────────────────────────────────────────────── */
export default function Merchant() {
  const { token, user } = useAuth();
  const qc = useQueryClient();
  const [refreshKey, setRefreshKey] = useState(0);

  /* Fetch all merchants and filter by userId */
  const merchantsQ = useQuery({
    queryKey: ["merchants", user?.id, refreshKey],
    queryFn: async () => {
      const data = await apiFetch<any>("/merchants?limit=100", token);
      const myMerchant = (data.merchants ?? []).find((m: any) => m.userId === user?.id);
      return myMerchant ?? null;
    },
    enabled: !!user?.id,
    staleTime: 10_000,
  });
  const merchant = merchantsQ.data;

  /* Wallet for merchant */
  const merchantWalletQ = useQuery({
    queryKey: ["merchant-wallet", merchant?.walletId],
    queryFn: () => apiFetch<any>(`/wallets/${merchant.walletId}`, token),
    enabled: !!merchant?.walletId,
    staleTime: 15_000,
  });
  const mWallet = merchantWalletQ.data;

  /* Recent payments */
  const txQ = useQuery({
    queryKey: ["merchant-transactions", merchant?.walletId],
    queryFn: () => apiFetch<any>(`/transactions?walletId=${merchant.walletId}&limit=10`, token),
    enabled: !!merchant?.walletId,
    staleTime: 15_000,
  });
  const payments = txQ.data?.transactions ?? [];

  const s = STATUS_CONFIG[merchant?.status ?? "pending_approval"] ?? STATUS_CONFIG.pending_approval;

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar title="Espace Marchand" />

      <main className="px-4 pt-4 pb-6 max-w-lg mx-auto space-y-4">

        {/* Back to diaspora */}
        <Link href="/diaspora">
          <button className="flex items-center gap-1.5 text-sm font-medium mb-1" style={{ color: "#1A6B32" }}>
            <ChevronLeft size={16} /> Retour Diaspora
          </button>
        </Link>

        {merchantsQ.isLoading ? (
          <div className="space-y-4 animate-pulse">
            <div className="h-40 bg-white rounded-3xl border border-gray-100" />
            <div className="h-64 bg-white rounded-3xl border border-gray-100" />
          </div>
        ) : !merchant ? (
          <Onboarding userId={user?.id ?? ""} onCreated={() => setRefreshKey(k => k + 1)} />
        ) : null}

        {merchant && (
          <>
            {/* Dashboard header */}
            <div
              className="rounded-3xl p-6 text-white shadow-lg"
              style={{ background: "linear-gradient(135deg, #1A6B32 0%, #2D9148 100%)" }}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Store size={16} className="opacity-80" />
                    <span className="text-sm font-medium opacity-80">Compte Marchand</span>
                  </div>
                  <h1 className="text-2xl font-black">{merchant.businessName}</h1>
                  <p className="text-sm opacity-70 mt-0.5 capitalize">
                    {TYPE_LABELS[merchant.businessType] ?? merchant.businessType}
                  </p>
                </div>
                <span className="text-xs px-2 py-1 rounded-full font-bold" style={{ background: s.bg, color: s.color }}>
                  {s.label}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="bg-white/15 rounded-2xl p-3">
                  <p className="text-xs opacity-70 mb-0.5">Revenu total</p>
                  <p className="font-bold text-sm">{formatXOF(merchant.totalRevenue)}</p>
                </div>
                <div className="bg-white/15 rounded-2xl p-3">
                  <p className="text-xs opacity-70 mb-0.5">Transactions</p>
                  <p className="font-bold text-sm">{merchant.transactionCount ?? 0}</p>
                </div>
                <div className="bg-white/15 rounded-2xl p-3">
                  <p className="text-xs opacity-70 mb-0.5">Solde wallet</p>
                  <p className="font-bold text-sm">
                    {mWallet ? formatXOF(mWallet.availableBalance ?? mWallet.balance ?? 0) : "—"}
                  </p>
                </div>
              </div>
            </div>

            {/* QR Code */}
            <QRSection merchantId={merchant.id} businessName={merchant.businessName} />

            {/* Recent payments */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900 text-sm">Derniers paiements</h2>
              </div>

              {txQ.isLoading ? (
                <div className="divide-y divide-gray-50">
                  {[0,1,2].map(i => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3 animate-pulse">
                      <div className="w-8 h-8 rounded-full bg-gray-100 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="h-3 w-28 bg-gray-100 rounded mb-1.5" />
                        <div className="h-2.5 w-20 bg-gray-100 rounded" />
                      </div>
                      <div className="h-3 w-20 bg-gray-100 rounded" />
                    </div>
                  ))}
                </div>
              ) : payments.length === 0 ? (
                <div className="py-8 text-center text-sm text-gray-400">
                  Aucun paiement reçu pour l'instant
                </div>
              ) : null}

              <div className="divide-y divide-gray-50">
                {payments.map((tx: any) => {
                  const isCredit = tx.toWalletId === merchant.walletId;
                  const amt = parseFloat(tx.amount);
                  return (
                    <div key={tx.id} className="flex items-center gap-3 px-4 py-3">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                        style={{ background: isCredit ? "#F0FDF4" : "#FEF2F2" }}
                      >
                        <span className="text-sm">{isCredit ? "💳" : "↗"}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-900 truncate">
                          {tx.description ?? (isCredit ? "Paiement reçu" : "Transfert sortant")}
                        </p>
                        <p className="text-xs text-gray-500">
                          {new Date(tx.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                      <span
                        className="text-xs font-bold flex-shrink-0"
                        style={{ color: isCredit ? "#10B981" : "#EF4444" }}
                      >
                        {isCredit ? "+" : "-"}{formatXOF(amt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
