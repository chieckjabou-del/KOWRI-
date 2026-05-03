import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Shield, ChevronRight, CheckCircle2, Clock, XCircle,
  Upload, User, Calendar, CreditCard, Camera, FileText, ArrowLeft
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { TopBar } from "@/components/TopBar";

const TIER_INFO = [
  {
    level: 0,
    label: "Tier 0 — Vérifié par téléphone",
    limit: "100 000 XOF / mois",
    color: "#6B7280",
    bg: "#F3F4F6",
    description: "Accordé automatiquement à l'inscription",
  },
  {
    level: 1,
    label: "Tier 1 — Identité vérifiée",
    limit: "1 000 000 XOF / mois",
    color: "#1A6B32",
    bg: "#F0FDF4",
    description: "Fournissez une pièce d'identité et un selfie",
  },
  {
    level: 2,
    label: "Tier 2 — Vérification complète",
    limit: "10 000 000 XOF / mois",
    color: "#1D4ED8",
    bg: "#EFF6FF",
    description: "Justificatif de domicile + 2ème document",
  },
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function PhotoUpload({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="w-full border-2 border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center py-4 gap-2 text-gray-500 hover:border-green-400 transition-colors"
        style={{ minHeight: 80, background: value ? "#F0FDF4" : undefined }}
      >
        {value ? (
          <span className="text-green-700 text-sm font-medium flex items-center gap-1.5">
            <CheckCircle2 size={16} /> Photo chargée
          </span>
        ) : (
          <>
            <Upload size={20} />
            <span className="text-sm">Appuyer pour charger</span>
          </>
        )}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) onChange(await fileToBase64(file));
        }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
    pending:  { label: "En attente", color: "#D97706", bg: "#FEF3C7", icon: <Clock size={13} /> },
    verified: { label: "Vérifié",    color: "#16A34A", bg: "#F0FDF4", icon: <CheckCircle2 size={13} /> },
    rejected: { label: "Rejeté",     color: "#DC2626", bg: "#FEF2F2", icon: <XCircle size={13} /> },
    expired:  { label: "Expiré",     color: "#6B7280", bg: "#F3F4F6", icon: <XCircle size={13} /> },
  };
  const s = map[status] ?? map.pending;
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
      style={{ color: s.color, background: s.bg }}>
      {s.icon} {s.label}
    </span>
  );
}

export default function KYC() {
  const { token, user } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [activeForm, setActiveForm] = useState<1 | 2 | null>(null);

  const [t1, setT1] = useState({
    fullName: "", dateOfBirth: "", documentNumber: "",
    documentFront: "", selfie: "",
  });
  const [t2, setT2] = useState({
    fullName: "", dateOfBirth: "", documentNumber: "",
    documentFront: "", selfie: "", proofOfAddress: "", secondDocument: "",
  });

  const { data: kycData } = useQuery({
    queryKey: ["kyc", user?.id],
    queryFn: () => apiFetch<any>(`/users/${user?.id}/kyc`, token),
    enabled: !!user?.id,
  });

  const { data: userData } = useQuery({
    queryKey: ["user", user?.id],
    queryFn: () => apiFetch<any>(`/users/${user?.id}`, token),
    enabled: !!user?.id,
  });

  const currentLevel: number = userData?.kycLevel ?? 0;
  const latestKyc = kycData?.record;

  const submitKyc = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch(`/users/${user?.id}/kyc`, token, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kyc"] });
      qc.invalidateQueries({ queryKey: ["user"] });
      setActiveForm(null);
    },
  });

  function handleSubmitT1() {
    if (!t1.fullName || !t1.dateOfBirth || !t1.documentNumber) return;
    submitKyc.mutate({
      kycLevel: 1,
      documentType: "national_id",
      fullName: t1.fullName,
      dateOfBirth: t1.dateOfBirth,
      documentNumber: t1.documentNumber,
      documentFront: t1.documentFront,
      selfie: t1.selfie,
    });
  }

  function handleSubmitT2() {
    if (!t2.fullName || !t2.dateOfBirth || !t2.documentNumber) return;
    submitKyc.mutate({
      kycLevel: 2,
      documentType: "national_id",
      fullName: t2.fullName,
      dateOfBirth: t2.dateOfBirth,
      documentNumber: t2.documentNumber,
      documentFront: t2.documentFront,
      selfie: t2.selfie,
      proofOfAddress: t2.proofOfAddress,
      secondDocument: t2.secondDocument,
    });
  }

  if (activeForm === 1) {
    return (
      <div className="min-h-screen flex flex-col" style={{ background: "#FAFAF8" }}>
        <header className="sticky top-0 z-40 bg-white border-b border-gray-100 flex items-center gap-3 px-4" style={{ height: 56 }}>
          <button onClick={() => setActiveForm(null)} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
            <ArrowLeft size={20} />
          </button>
          <span className="font-semibold text-gray-900">KYC — Tier 1</span>
        </header>

        <div className="flex-1 px-4 py-5 space-y-4 pb-10">
          <div className="bg-green-50 rounded-xl p-3 text-sm text-green-800 font-medium">
            Après approbation : limite portée à 1 000 000 XOF / mois
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nom complet</label>
            <input
              value={t1.fullName}
              onChange={e => setT1(p => ({ ...p, fullName: e.target.value }))}
              placeholder="Prénom Nom"
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-green-500"
              style={{ minHeight: 48 }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date de naissance</label>
            <input
              type="date"
              value={t1.dateOfBirth}
              onChange={e => setT1(p => ({ ...p, dateOfBirth: e.target.value }))}
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-green-500"
              style={{ minHeight: 48 }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Numéro d'identité nationale (NIN)</label>
            <input
              value={t1.documentNumber}
              onChange={e => setT1(p => ({ ...p, documentNumber: e.target.value }))}
              placeholder="Ex: CI-2024-XXXXXX"
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-green-500"
              style={{ minHeight: 48 }}
            />
          </div>

          <PhotoUpload label="Photo recto de la pièce d'identité"
            value={t1.documentFront} onChange={v => setT1(p => ({ ...p, documentFront: v }))} />

          <PhotoUpload label="Selfie (visage visible)"
            value={t1.selfie} onChange={v => setT1(p => ({ ...p, selfie: v }))} />

          <button
            onClick={handleSubmitT1}
            disabled={submitKyc.isPending || !t1.fullName || !t1.dateOfBirth || !t1.documentNumber}
            className="w-full py-4 rounded-2xl font-bold text-white text-sm mt-2 disabled:opacity-50"
            style={{ background: "#1A6B32", minHeight: 52 }}
          >
            {submitKyc.isPending ? "Envoi en cours…" : "Soumettre le dossier Tier 1"}
          </button>

          {submitKyc.isError && (
            <p className="text-red-600 text-sm text-center">
              {(submitKyc.error as any)?.message ?? "Erreur lors de la soumission"}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (activeForm === 2) {
    return (
      <div className="min-h-screen flex flex-col" style={{ background: "#FAFAF8" }}>
        <header className="sticky top-0 z-40 bg-white border-b border-gray-100 flex items-center gap-3 px-4" style={{ height: 56 }}>
          <button onClick={() => setActiveForm(null)} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
            <ArrowLeft size={20} />
          </button>
          <span className="font-semibold text-gray-900">KYC — Tier 2</span>
        </header>

        <div className="flex-1 px-4 py-5 space-y-4 pb-10">
          <div className="bg-blue-50 rounded-xl p-3 text-sm text-blue-800 font-medium">
            Après approbation : limite portée à 10 000 000 XOF / mois
          </div>

          {[
            { key: "fullName", label: "Nom complet", type: "text", placeholder: "Prénom Nom" },
            { key: "dateOfBirth", label: "Date de naissance", type: "date", placeholder: "" },
            { key: "documentNumber", label: "Numéro NIN", type: "text", placeholder: "Ex: CI-2024-XXXXXX" },
          ].map(f => (
            <div key={f.key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
              <input
                type={f.type}
                value={(t2 as any)[f.key]}
                onChange={e => setT2(p => ({ ...p, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
                style={{ minHeight: 48 }}
              />
            </div>
          ))}

          <PhotoUpload label="Photo recto pièce d'identité"
            value={t2.documentFront} onChange={v => setT2(p => ({ ...p, documentFront: v }))} />
          <PhotoUpload label="Selfie"
            value={t2.selfie} onChange={v => setT2(p => ({ ...p, selfie: v }))} />
          <PhotoUpload label="Justificatif de domicile (facture d'eau, d'électricité…)"
            value={t2.proofOfAddress} onChange={v => setT2(p => ({ ...p, proofOfAddress: v }))} />
          <PhotoUpload label="Deuxième document d'identité"
            value={t2.secondDocument} onChange={v => setT2(p => ({ ...p, secondDocument: v }))} />

          <button
            onClick={handleSubmitT2}
            disabled={submitKyc.isPending || !t2.fullName || !t2.dateOfBirth || !t2.documentNumber}
            className="w-full py-4 rounded-2xl font-bold text-white text-sm mt-2 disabled:opacity-50"
            style={{ background: "#1D4ED8", minHeight: 52 }}
          >
            {submitKyc.isPending ? "Envoi en cours…" : "Soumettre le dossier Tier 2"}
          </button>

          {submitKyc.isError && (
            <p className="text-red-600 text-sm text-center">
              {(submitKyc.error as any)?.message ?? "Erreur lors de la soumission"}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-8" style={{ background: "#FAFAF8" }}>
      <TopBar title="Vérification KYC" showBack onBack={() => setLocation("/profile")} />

      <div className="px-4 pt-5 space-y-4 max-w-lg mx-auto">
        {/* Current level banner */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 flex items-center gap-4">
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-black text-xl"
            style={{ background: "linear-gradient(135deg, #1A6B32, #2D9148)" }}>
            {currentLevel}
          </div>
          <div>
            <p className="font-bold text-gray-900">Niveau actuel : Tier {currentLevel}</p>
            <p className="text-sm text-gray-500">
              Plafond mensuel : {(KYC_MONTHLY_LIMITS[currentLevel] ?? 100000).toLocaleString("fr-FR")} XOF
            </p>
          </div>
        </div>

        {/* Latest KYC record */}
        {latestKyc && (
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-700">Dernier dossier soumis</p>
              <StatusBadge status={latestKyc.status} />
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Tier {latestKyc.kycLevel} · {new Date(latestKyc.submittedAt).toLocaleDateString("fr-FR")}
            </p>
            {latestKyc.rejectionReason && (
              <p className="mt-2 text-sm text-red-600">Motif : {latestKyc.rejectionReason}</p>
            )}
          </div>
        )}

        {/* Tier cards */}
        {TIER_INFO.map(tier => {
          const isCurrentOrBelow = currentLevel >= tier.level;
          const isPending = latestKyc?.kycLevel === tier.level && latestKyc?.status === "pending";
          const canApply = !isCurrentOrBelow && !isPending && (tier.level === 1 ? true : currentLevel >= 1);

          return (
            <div key={tier.level}
              className="bg-white rounded-2xl border border-gray-100 overflow-hidden"
            >
              <div className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Shield size={16} style={{ color: tier.color }} />
                      <span className="font-semibold text-sm text-gray-900">{tier.label}</span>
                    </div>
                    <p className="text-xs text-gray-500 mb-2">{tier.description}</p>
                    <span className="text-xs font-bold px-2 py-1 rounded-lg"
                      style={{ color: tier.color, background: tier.bg }}>
                      Plafond : {tier.limit}
                    </span>
                  </div>

                  <div className="ml-3 flex-shrink-0">
                    {isCurrentOrBelow ? (
                      <CheckCircle2 size={22} style={{ color: "#1A6B32" }} />
                    ) : isPending ? (
                      <Clock size={22} className="text-amber-500" />
                    ) : (
                      <div className="w-6 h-6 rounded-full border-2 border-gray-200" />
                    )}
                  </div>
                </div>
              </div>

              {canApply && (
                <button
                  onClick={() => setActiveForm(tier.level as 1 | 2)}
                  className="w-full border-t border-gray-50 flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <span className="text-sm font-semibold" style={{ color: tier.color }}>
                    Soumettre le dossier Tier {tier.level}
                  </span>
                  <ChevronRight size={16} style={{ color: tier.color }} />
                </button>
              )}

              {isPending && (
                <div className="border-t border-gray-50 px-4 py-3 bg-amber-50">
                  <p className="text-xs text-amber-700 font-medium">
                    Dossier en cours d'examen · Délai : 1–3 jours ouvrables
                  </p>
                </div>
              )}
            </div>
          );
        })}

        {/* Limits summary */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Plafonds par niveau</p>
          <div className="space-y-2">
            {[
              { level: "Tier 0", limit: "100 000 XOF", desc: "Téléphone vérifié" },
              { level: "Tier 1", limit: "1 000 000 XOF", desc: "Pièce d'identité + selfie" },
              { level: "Tier 2", limit: "10 000 000 XOF", desc: "Vérification complète" },
            ].map(r => (
              <div key={r.level} className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-gray-900">{r.level}</span>
                  <span className="text-xs text-gray-400 ml-2">{r.desc}</span>
                </div>
                <span className="text-sm font-semibold text-gray-700">{r.limit}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const KYC_MONTHLY_LIMITS: Record<number, number> = {
  0: 100_000,
  1: 1_000_000,
  2: 10_000_000,
};
