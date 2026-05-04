import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import {
  LogOut, User, Phone, MapPin, Shield, Camera, ChevronRight,
  MessageSquare, X, CheckCircle, ChevronDown, ChevronUp,
  Star, Award, TrendingUp, ArrowUpRight, ArrowDownLeft, Loader2,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, formatXOF, relativeTime } from "@/lib/api";

const KYC_LIMIT_LABELS: Record<number, string> = {
  0: "100 000 XOF / mois",
  1: "1 000 000 XOF / mois",
  2: "10 000 000 XOF / mois",
};

const KYC_LEVEL_LABELS: Record<number, string> = {
  0: "Tier 0 — Téléphone vérifié",
  1: "Tier 1 — Identité vérifiée",
  2: "Tier 2 — Vérification complète",
};

const TICKET_CATEGORY_LABELS: Record<string, string> = {
  TRANSACTION_ISSUE: "Problème de transaction",
  ACCOUNT_LOCKED:    "Compte bloqué",
  WRONG_AMOUNT:      "Montant incorrect",
  AGENT_COMPLAINT:   "Plainte sur agent",
  APP_BUG:           "Bug de l'application",
  OTHER:             "Autre",
};

const TICKET_STATUS_COLORS: Record<string, string> = {
  OPEN:        "#D97706",
  IN_PROGRESS: "#2563EB",
  RESOLVED:    "#16A34A",
  CLOSED:      "#6B7280",
};

const REP_TIERS: Record<string, { label: string; ring: string; bg: string; color: string }> = {
  NOUVEAU:  { label: "NOUVEAU",  ring: "#9CA3AF", bg: "#F3F4F6", color: "#4B5563" },
  BRONZE:   { label: "BRONZE",   ring: "#D97706", bg: "#FEF3C7", color: "#92400E" },
  SILVER:   { label: "ARGENT",   ring: "#3B82F6", bg: "#EFF6FF", color: "#1D4ED8" },
  GOLD:     { label: "OR",       ring: "#F59E0B", bg: "#FFFBEB", color: "#B45309" },
  PLATINUM: { label: "PLATINE",  ring: "#8B5CF6", bg: "#F5F3FF", color: "#6D28D9" },
};

const REP_FACTORS = [
  { key: "tontineParticipation", label: "Fiabilité tontine",        max: 25 },
  { key: "paymentHistory",       label: "Remboursements",            max: 20 },
  { key: "transactionVolume",    label: "Volume transactions",       max: 30 },
  { key: "networkScore",         label: "Engagement communauté",    max: 15 },
  { key: "savingsRegularity",    label: "Discipline d'épargne",     max: 10 },
];

const TX_FILTERS = ["Tous", "send", "receive", "tontine", "credit"] as const;
const TX_FILTER_LABELS: Record<string, string> = {
  Tous: "Tous", send: "Envois", receive: "Reçus", tontine: "Tontines", credit: "Crédits",
};

const TX_PAGE_SIZE = 15;

/* ─── Reputation ring ─────────────────────────────────────────────────────── */
function RepRing({ score, tier }: { score: number; tier: string }) {
  const t = REP_TIERS[tier] ?? REP_TIERS.NOUVEAU;
  const s = Math.min(Math.max(Math.round(score), 0), 100);
  const r = 52;
  const circ = 2 * Math.PI * r;
  const dash = ((s / 100) * circ).toFixed(1);
  return (
    <div className="flex flex-col items-center py-4">
      <div className="relative w-36 h-36">
        <svg width="144" height="144" viewBox="0 0 144 144" className="-rotate-90">
          <circle cx="72" cy="72" r={r} fill="none" stroke="#F3F4F6" strokeWidth="12" />
          <circle
            cx="72" cy="72" r={r} fill="none"
            stroke={t.ring} strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            style={{ transition: "stroke-dasharray 0.6s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-4xl font-black text-gray-900">{s}</span>
          <span className="text-xs text-gray-500">/ 100</span>
        </div>
      </div>
      <span
        className="mt-2 px-4 py-1 rounded-full text-xs font-bold tracking-wider"
        style={{ background: t.bg, color: t.color }}
      >
        {t.label}
      </span>
    </div>
  );
}

/* ─── Factor bar ──────────────────────────────────────────────────────────── */
function FactorBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pts  = Math.round(value * max);
  const pct  = Math.min(Math.round(value * 100), 100);
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs text-gray-600 mb-1">
        <span>{label}</span>
        <span className="font-semibold text-gray-900">{pts}/{max} pts</span>
      </div>
      <div className="h-2.5 rounded-full overflow-hidden" style={{ background: "#F3F4F6" }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: "#1A6B32" }}
        />
      </div>
    </div>
  );
}

/* ─── Badge chip ──────────────────────────────────────────────────────────── */
const BADGE_ICONS: Record<string, string> = {
  FIRST_100_CLIENTS:    "🏅",
  VOLUME_5M:            "💰",
  VOLUME_20M:           "💎",
  ZERO_ANOMALIES_30D:   "✅",
  TOP_ZONE_AGENT:       "🏆",
  TRUSTED_VETERAN:      "⭐",
  TONTINE_CHAMPION:     "🎯",
  FIRST_TONTINE:        "🤝",
  RELIABLE_PAYER:       "💳",
  EARLY_ADOPTER:        "🚀",
  COMMUNITY_BUILDER:    "🌍",
};

function BadgeChip({ badge }: { badge: any }) {
  const icon = BADGE_ICONS[badge.badge] ?? "🏅";
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-2.5 rounded-2xl border border-gray-100 bg-white flex-shrink-0 min-w-[72px]">
      <span className="text-2xl">{icon}</span>
      <span className="text-[10px] font-medium text-gray-600 text-center leading-tight max-w-[64px]">
        {badge.label ?? badge.badge.replace(/_/g, " ")}
      </span>
    </div>
  );
}

/* ─── Transaction row ──────────────────────────────────────────────────────  */
function TxRow({ tx }: { tx: any }) {
  const isIn = tx.direction === "in" || tx.type === "receive" || tx.type === "tontine_receive";
  const icon = isIn
    ? <ArrowDownLeft size={16} style={{ color: "#16A34A" }} />
    : <ArrowUpRight  size={16} style={{ color: "#DC2626" }} />;
  const amtColor = isIn ? "#16A34A" : "#DC2626";
  const prefix   = isIn ? "+" : "-";

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
        style={{ background: isIn ? "#F0FDF4" : "#FEF2F2" }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">
          {tx.description ?? tx.type ?? "Transaction"}
        </p>
        <p className="text-xs text-gray-400">{relativeTime(tx.createdAt)}</p>
      </div>
      <p className="text-sm font-bold flex-shrink-0" style={{ color: amtColor }}>
        {prefix}{formatXOF(Math.abs(Number(tx.amount)))}
      </p>
    </div>
  );
}

/* ─── Main component ──────────────────────────────────────────────────────── */
export default function Profile() {
  const { user, logout, token, isFounder } = useAuth();
  const [, navigate]   = useLocation();
  const qc             = useQueryClient();
  const fileRef        = useRef<HTMLInputElement>(null);
  const [avatarPreview, setAvatarPreview]   = useState<string | null>(null);
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [ticketCategory, setTicketCategory]     = useState("OTHER");
  const [ticketTitle, setTicketTitle]           = useState("");
  const [ticketDesc, setTicketDesc]             = useState("");
  const [ticketCreated, setTicketCreated]       = useState<string | null>(null);
  const [showRepFactors, setShowRepFactors]     = useState(false);
  const [txFilter, setTxFilter]                 = useState<string>("Tous");
  const [txPage, setTxPage]                     = useState(1);
  const [showPinModal, setShowPinModal]         = useState(false);
  const [currentPin, setCurrentPin]             = useState("");
  const [newPin, setNewPin]                     = useState("");
  const [confirmPin, setConfirmPin]             = useState("");
  const [pinError, setPinError]                 = useState("");
  const [pinSuccess, setPinSuccess]             = useState(false);

  /* ── Queries ── */
  const { data: userData } = useQuery({
    queryKey: ["user", user?.id],
    queryFn: () => apiFetch<any>(`/users/${user?.id}`, token),
    enabled: !!user?.id,
  });

  const { data: kycData } = useQuery({
    queryKey: ["kyc", user?.id],
    queryFn: () => apiFetch<any>(`/users/${user?.id}/kyc`, token),
    enabled: !!user?.id,
  });

  const { data: ticketsData } = useQuery({
    queryKey: ["support-tickets", user?.id],
    queryFn: () => apiFetch<any>(`/support/tickets?userId=${user?.id}&limit=5`, token),
    enabled: !!user?.id,
  });

  const walletsQ = useQuery({
    queryKey: ["wallets", user?.id],
    queryFn: () => apiFetch<any>(`/wallets?userId=${user?.id}&limit=1`, token),
    enabled: !!user?.id,
    staleTime: 15_000,
  });
  const wallet = walletsQ.data?.wallets?.[0] ?? null;

  const repQ = useQuery({
    queryKey: ["reputation", user?.id],
    queryFn: () => apiFetch<any>(`/community/reputation/${user?.id}`, token),
    enabled: !!user?.id,
    retry: false,
    staleTime: 30_000,
  });

  const badgesQ = useQuery({
    queryKey: ["reputation-badges", user?.id],
    queryFn: () => apiFetch<any>(`/community/reputation/${user?.id}/badges`, token),
    enabled: !!user?.id && !!repQ.data,
    retry: false,
    staleTime: 60_000,
  });

  const txQ = useQuery({
    queryKey: ["transactions", wallet?.id, txFilter, txPage],
    queryFn: () => {
      const type  = txFilter !== "Tous" ? `&type=${txFilter}` : "";
      return apiFetch<any>(
        `/transactions?walletId=${wallet?.id}&limit=${TX_PAGE_SIZE}&page=${txPage}${type}`,
        token,
      );
    },
    enabled: !!wallet?.id,
    staleTime: 15_000,
    placeholderData: (prev: any) => prev,
  });

  /* ── Mutations ── */
  const createTicketMut = useMutation({
    mutationFn: (body: object) =>
      apiFetch<any>("/support/tickets", token, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (data: any) => {
      setTicketCreated(data.ticketNumber);
      setTicketTitle("");
      setTicketDesc("");
      qc.invalidateQueries({ queryKey: ["support-tickets"] });
    },
  });

  const avatarMut = useMutation({
    mutationFn: (avatarBase64: string) =>
      apiFetch(`/users/${user?.id}/avatar`, token, {
        method: "PATCH",
        body: JSON.stringify({ avatarBase64 }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user"] }),
  });

  const computeRepMut = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/community/reputation/${user?.id}/compute`, token, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reputation", user?.id] });
      qc.invalidateQueries({ queryKey: ["reputation-badges", user?.id] });
    },
  });

  const changePinMut = useMutation({
    mutationFn: () => {
      const cur = currentPin.trim();
      const nxt = newPin.trim();
      const conf = confirmPin.trim();
      if (!/^\d{4}$/.test(cur)) throw new Error("PIN actuel invalide (4 chiffres)");
      if (!/^\d{4}$/.test(nxt)) throw new Error("Nouveau PIN invalide (4 chiffres)");
      if (nxt !== conf) throw new Error("Les PIN ne correspondent pas");
      if (cur === nxt) throw new Error("Le nouveau PIN doit être différent");
      return apiFetch<any>(`/users/${user?.id}/pin`, token, {
        method: "PATCH",
        body: JSON.stringify({ oldPin: cur, newPin: nxt }),
      });
    },
    onSuccess: () => {
      setPinError("");
      setPinSuccess(true);
      setCurrentPin("");
      setNewPin("");
      setConfirmPin("");
    },
    onError: (e: any) => setPinError(e.message ?? "Impossible de changer le PIN"),
  });

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result as string;
      setAvatarPreview(b64);
      avatarMut.mutate(b64);
    };
    reader.readAsDataURL(file);
  }

  function handleLogout() {
    logout();
    navigate("/login");
  }

  function openPinModal() {
    setPinError("");
    setPinSuccess(false);
    setCurrentPin("");
    setNewPin("");
    setConfirmPin("");
    setShowPinModal(true);
  }

  const kycLevel   = userData?.kycLevel ?? 0;
  const avatarUrl  = avatarPreview ?? userData?.avatarUrl ?? null;
  const latestKyc  = kycData?.record;
  const rep        = repQ.data;
  const badges: any[] = badgesQ.data?.badges ?? [];
  const txData: any    = txQ.data ?? {};
  const txs: any[]    = Array.isArray(txData.transactions) ? txData.transactions
                       : Array.isArray(txData.entries) ? txData.entries : [];
  const txTotal: number = txData.pagination?.total ?? txs.length;
  const hasMoreTx  = txs.length >= TX_PAGE_SIZE;

  /* ── Reputation tier by score ── */
  function repTierFromScore(score: number): string {
    if (score >= 80) return "PLATINUM";
    if (score >= 60) return "GOLD";
    if (score >= 40) return "SILVER";
    if (score >= 20) return "BRONZE";
    return "NOUVEAU";
  }
  const repScore = rep?.score ?? 0;
  const repTier  = rep?.tier ?? repTierFromScore(repScore);

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar title="Mon Profil" />

      <main className="px-4 pt-5 max-w-lg mx-auto space-y-4">

        {/* ─── Avatar card ─────────────────────────────── */}
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col items-center text-center">
          <div className="relative mb-3">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Avatar"
                className="w-20 h-20 rounded-full object-cover border-2 border-gray-100"
              />
            ) : (
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-black text-white"
                style={{ background: "linear-gradient(135deg, #1A6B32, #2D9148)" }}
              >
                {user?.firstName?.[0]}{user?.lastName?.[0]}
              </div>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center hover:bg-gray-50 shadow-sm"
            >
              <Camera size={13} className="text-gray-600" />
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
          </div>

          <h1 className="text-xl font-bold text-gray-900">{user?.firstName} {user?.lastName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{user?.phone}</p>
          <span className="mt-2 text-xs px-3 py-1 rounded-full font-medium capitalize" style={{ background: "#F0FDF4", color: "#16A34A" }}>
            {user?.status ?? "actif"}
          </span>
          {avatarMut.isPending && <p className="text-xs text-gray-400 mt-2">Enregistrement…</p>}
        </div>

        {/* ─── Reputation score ─────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 pt-4 pb-1 border-b border-gray-50 flex items-center gap-2">
            <Star size={14} style={{ color: "#F59E0B" }} />
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Réputation</p>
          </div>

          <div style={{ display: repQ.isLoading ? "block" : "none" }} aria-hidden={!repQ.isLoading}>
            <div className="py-8 flex flex-col items-center animate-pulse gap-4">
              <div className="w-36 h-36 rounded-full bg-gray-100" />
              <div className="h-4 w-28 bg-gray-100 rounded" />
            </div>
          </div>

          <div style={{ display: !repQ.isLoading && !rep ? "block" : "none" }} aria-hidden={repQ.isLoading || !!rep}>
            <div className="py-7 flex flex-col items-center px-6 text-center">
              <div className="w-14 h-14 rounded-2xl mb-3 flex items-center justify-center" style={{ background: "#FEF3C7" }}>
                <Star size={26} style={{ color: "#D97706" }} />
              </div>
              <p className="font-bold text-gray-900 text-sm mb-1">Pas encore de score</p>
              <p className="text-xs text-gray-500 mb-4">Calculez votre réputation communautaire</p>
              <button
                onClick={() => computeRepMut.mutate()}
                disabled={computeRepMut.isPending}
                className="px-5 py-2.5 rounded-xl font-bold text-white text-sm flex items-center gap-2 disabled:opacity-70"
                style={{ background: "#1A6B32", minHeight: 44 }}
              >
                {computeRepMut.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                Calculer mon score
              </button>
            </div>
          </div>

          <div style={{ display: !repQ.isLoading && !!rep ? "block" : "none" }} aria-hidden={repQ.isLoading || !rep}>
            <div className="px-4 pb-4">
              <RepRing score={repScore} tier={repTier} />

              {/* Collapsible factors */}
              <button
                onClick={() => setShowRepFactors(v => !v)}
                className="w-full flex items-center justify-between text-sm font-semibold text-gray-700 py-1 mb-2"
              >
                <span>Détail du score</span>
                {showRepFactors ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              <div style={{ display: showRepFactors ? "block" : "none" }} aria-hidden={!showRepFactors}>
                <div className="mb-3">
                  {REP_FACTORS.map(f => (
                    <FactorBar
                      key={f.key}
                      label={f.label}
                      value={rep?.factors?.[f.key] ?? rep?.[f.key] ?? 0}
                      max={f.max}
                    />
                  ))}
                </div>
              </div>

              <button
                onClick={() => computeRepMut.mutate()}
                disabled={computeRepMut.isPending}
                className="w-full py-2.5 rounded-xl font-semibold text-sm border border-gray-200 flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ color: "#1A6B32", minHeight: 44 }}
              >
                {computeRepMut.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                Recalculer mon score
              </button>
            </div>
          </div>
        </div>

        {/* ─── Badges ──────────────────────────────── */}
        {(badges.length > 0 || badgesQ.data) && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-4 pt-4 pb-2 border-b border-gray-50 flex items-center gap-2">
              <Award size={14} style={{ color: "#1A6B32" }} />
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                Badges {badges.length > 0 && `(${badges.length})`}
              </p>
            </div>
            {badges.length === 0 ? (
              <div className="px-4 py-5 text-center">
                <p className="text-sm text-gray-400">Aucun badge encore — continuez à utiliser AKWE !</p>
              </div>
            ) : (
              <div className="px-4 py-3 flex gap-3 overflow-x-auto hide-scrollbar">
                {badges.map((b: any, i: number) => (
                  <BadgeChip key={b.id ?? b.badgeId ?? `${b.badge ?? "badge"}-${i}`} badge={b} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ─── KYC ─────────────────────────────────── */}
        <button
          onClick={() => navigate("/kyc")}
          className="w-full bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden text-left"
        >
          <div className="flex items-center gap-3 px-4 py-4">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold"
              style={{ background: kycLevel === 0 ? "#6B7280" : kycLevel === 1 ? "#1A6B32" : "#1D4ED8" }}
            >
              {kycLevel}
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">{KYC_LEVEL_LABELS[kycLevel] ?? "Tier 0"}</p>
              <p className="text-xs text-gray-500">Plafond : {KYC_LIMIT_LABELS[kycLevel]}</p>
              {latestKyc?.status === "pending" && (
                <p className="text-xs text-amber-600 font-medium mt-0.5">Dossier en cours d'examen…</p>
              )}
            </div>
            <ChevronRight size={16} className="text-gray-400" />
          </div>
          {kycLevel < 2 && (
            <div className="border-t border-gray-50 px-4 py-2 bg-green-50">
              <p className="text-xs text-green-700 font-medium">
                Augmenter votre plafond → Soumettre un dossier KYC
              </p>
            </div>
          )}
        </button>

        {/* ─── Info ────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <InfoRow icon={<User size={16} />}   label="Nom complet"     value={`${user?.firstName} ${user?.lastName}`} />
          <InfoRow icon={<Phone size={16} />}   label="Téléphone"       value={user?.phone ?? "—"} />
          <InfoRow icon={<MapPin size={16} />}  label="Pays"            value={user?.country ?? "—"} />
          <InfoRow icon={<Shield size={16} />}  label="Statut du compte" value={user?.status ?? "actif"} last />
        </div>

        {/* ─── Transaction history ─────────────────── */}
        {wallet && (
          <section>
            <h2 className="font-bold text-gray-900 mb-3 text-base">Historique des transactions</h2>

            {/* Filter tabs */}
            <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3 hide-scrollbar">
              {TX_FILTERS.map(f => {
                const active = txFilter === f;
                return (
                  <button
                    key={f}
                    onClick={() => { setTxFilter(f); setTxPage(1); }}
                    className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all"
                    style={{
                      background: active ? "#1A6B32" : "#F3F4F6",
                      color: active ? "#fff" : "#6B7280",
                    }}
                  >
                    {TX_FILTER_LABELS[f]}
                  </button>
                );
              })}
            </div>

            {txQ.isLoading ? (
              <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50 overflow-hidden">
                {[0, 1, 2, 4].map(i => (
                  <div key={i} className="px-4 py-3 flex items-center gap-3 animate-pulse">
                    <div className="w-9 h-9 rounded-full bg-gray-100 flex-shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 bg-gray-100 rounded w-2/3" />
                      <div className="h-2.5 bg-gray-100 rounded w-1/3" />
                    </div>
                    <div className="h-3 bg-gray-100 rounded w-16" />
                  </div>
                ))}
              </div>
            ) : txs.length === 0 ? (
              <div className="bg-white rounded-2xl p-6 text-center border border-gray-100">
                <TrendingUp size={24} className="text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">Aucune transaction trouvée</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
                <div className="divide-y divide-gray-50">
                  {txs.map((tx: any) => <TxRow key={tx.id} tx={tx} />)}
                </div>

                {hasMoreTx && (
                  <div className="border-t border-gray-50 p-3">
                    <button
                      onClick={() => setTxPage(p => p + 1)}
                      disabled={txQ.isFetching}
                      className="w-full py-2.5 rounded-xl text-sm font-semibold border border-gray-200 flex items-center justify-center gap-2 disabled:opacity-60"
                      style={{ color: "#1A6B32", minHeight: 44 }}
                    >
                      {txQ.isFetching ? <Loader2 size={14} className="animate-spin" /> : null}
                      Charger plus
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ─── Security ────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <button
            onClick={openPinModal}
            className="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-gray-50 transition-colors"
          >
            <Shield size={18} className="text-gray-500" />
            <div>
              <p className="text-sm font-medium text-gray-900">Changer mon PIN</p>
              <p className="text-xs text-gray-500">Sécurité du compte</p>
            </div>
          </button>
        </div>

        {/* ─── Support ─────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 pt-4 pb-2 border-b border-gray-50">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Support</p>
          </div>
          <button
            onClick={() => { setShowSupportModal(true); setTicketCreated(null); }}
            className="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-gray-50 transition-colors border-b border-gray-50"
          >
            <MessageSquare size={18} className="text-gray-500" />
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">Signaler un problème</p>
              <p className="text-xs text-gray-500">Créer un ticket d'assistance</p>
            </div>
            <ChevronRight size={16} className="text-gray-400" />
          </button>

          {ticketsData?.tickets?.length > 0 && (
            <div className="px-4 py-3">
              <p className="text-xs font-medium text-gray-500 mb-2">Mes tickets récents</p>
              <div className="space-y-2">
                {ticketsData.tickets.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm font-medium text-gray-900 truncate max-w-[180px]">{t.ticketNumber}</p>
                      <p className="text-xs text-gray-500">{TICKET_CATEGORY_LABELS[t.category] ?? t.category}</p>
                    </div>
                    <span
                      className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{
                        background: (TICKET_STATUS_COLORS[t.status] ?? "#6B7280") + "20",
                        color: TICKET_STATUS_COLORS[t.status] ?? "#6B7280",
                      }}
                    >
                      {t.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {isFounder ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-4 pt-4 pb-2 border-b border-gray-50">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Founder mode</p>
            </div>
            <button
              onClick={() => navigate("/founder")}
              className="w-full flex items-center gap-3 px-4 py-4 text-left hover:bg-gray-50 transition-colors"
            >
              <TrendingUp size={18} className="text-gray-500" />
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">Ouvrir Founder Dashboard</p>
                <p className="text-xs text-gray-500">Activation, retention proxy, referral et volume</p>
              </div>
              <ChevronRight size={16} className="text-gray-400" />
            </button>
          </div>
        ) : null}

        {/* ─── Logout ──────────────────────────────── */}
        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-semibold text-sm border border-red-100 bg-white"
          style={{ color: "#DC2626", minHeight: 52 }}
        >
          <LogOut size={18} />
          Se déconnecter
        </button>
      </main>

      {/* ─── Support Modal ───────────────────────── */}
      {showSupportModal && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="w-full bg-white rounded-t-3xl px-4 pt-5 pb-8 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900">Signaler un problème</h2>
              <button
                onClick={() => { setShowSupportModal(false); setTicketCreated(null); }}
                className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center"
              >
                <X size={16} className="text-gray-600" />
              </button>
            </div>

            {ticketCreated ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <CheckCircle size={48} className="text-green-600" />
                <p className="text-base font-semibold text-gray-900">Ticket créé avec succès</p>
                <p className="text-sm text-gray-500 text-center">
                  Votre ticket <span className="font-mono font-bold text-green-700">{ticketCreated}</span> a été créé.<br />
                  Notre équipe vous répondra bientôt.
                </p>
                <button
                  onClick={() => { setShowSupportModal(false); setTicketCreated(null); }}
                  className="mt-4 w-full py-3 rounded-2xl text-white font-semibold text-sm"
                  style={{ background: "#1A6B32" }}
                >
                  Fermer
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Catégorie</label>
                  <select
                    value={ticketCategory}
                    onChange={e => setTicketCategory(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-3 py-3 text-sm bg-white"
                  >
                    {Object.entries(TICKET_CATEGORY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Titre</label>
                  <input
                    type="text"
                    placeholder="Ex: Transaction non reçue"
                    value={ticketTitle}
                    onChange={e => setTicketTitle(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-3 py-3 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
                  <textarea
                    placeholder="Décrivez votre problème en détail…"
                    value={ticketDesc}
                    onChange={e => setTicketDesc(e.target.value)}
                    rows={4}
                    className="w-full border border-gray-200 rounded-xl px-3 py-3 text-sm resize-none"
                  />
                </div>
                {createTicketMut.isError && (
                  <p className="text-xs text-red-600">Erreur lors de la création du ticket.</p>
                )}
                <button
                  disabled={!ticketTitle || !ticketDesc || createTicketMut.isPending}
                  onClick={() => createTicketMut.mutate({
                    userId: user?.id,
                    category: ticketCategory,
                    title: ticketTitle,
                    description: ticketDesc,
                  })}
                  className="w-full py-3.5 rounded-2xl text-white font-semibold text-sm disabled:opacity-50"
                  style={{ background: "#1A6B32" }}
                >
                  {createTicketMut.isPending ? "Envoi…" : "Envoyer le ticket"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── PIN Modal ───────────────────────────── */}
      {showPinModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowPinModal(false)} />
          <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pb-8 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-bold text-gray-900">Changer mon PIN</h2>
              <button onClick={() => setShowPinModal(false)} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            {pinSuccess ? (
              <div className="text-center py-6">
                <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F0FDF4" }}>
                  <CheckCircle size={32} style={{ color: "#16A34A" }} />
                </div>
                <p className="font-bold text-gray-900 text-lg mb-1">PIN mis à jour</p>
                <p className="text-sm text-gray-500 mb-6">Votre code PIN a bien été changé.</p>
                <button
                  onClick={() => setShowPinModal(false)}
                  className="w-full py-3 rounded-xl font-bold text-white"
                  style={{ background: "#1A6B32" }}
                >
                  Fermer
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">PIN actuel</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={currentPin}
                    onChange={e => setCurrentPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="••••"
                    className="w-full border border-gray-200 rounded-xl px-3 py-3 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Nouveau PIN</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={newPin}
                    onChange={e => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="••••"
                    className="w-full border border-gray-200 rounded-xl px-3 py-3 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Confirmer le nouveau PIN</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={confirmPin}
                    onChange={e => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="••••"
                    className="w-full border border-gray-200 rounded-xl px-3 py-3 text-sm"
                  />
                </div>

                {pinError ? (
                  <div className="px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                    {pinError}
                  </div>
                ) : null}

                <button
                  onClick={() => { setPinError(""); changePinMut.mutate(); }}
                  disabled={changePinMut.isPending}
                  className="w-full py-3.5 rounded-2xl text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ background: "#1A6B32" }}
                >
                  {changePinMut.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                  Mettre à jour le PIN
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <BottomNav />
    </div>
  );
}

function InfoRow({ icon, label, value, last }: { icon: React.ReactNode; label: string; value: string; last?: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-4 ${last ? "" : "border-b border-gray-50"}`}>
      <div className="text-gray-400">{icon}</div>
      <div className="flex-1">
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-sm font-medium text-gray-900">{value}</p>
      </div>
    </div>
  );
}
