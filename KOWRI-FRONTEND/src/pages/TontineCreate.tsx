import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { ChevronLeft, Loader2, Check, AlertCircle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, formatXOF, generateIdempotencyKey } from "@/lib/api";
import { TontineTypeCard } from "@/components/TontineTypeCard";
import { TopBar } from "@/components/TopBar";
import { TYPE_META, FREQ_LABELS } from "@/lib/tontineTypes";

const TYPES = Object.keys(TYPE_META);

const FREQ_OPTIONS = [
  { value: "weekly",   label: "Hebdomadaire" },
  { value: "biweekly", label: "Bimensuel"    },
  { value: "monthly",  label: "Mensuel"      },
];

type Step = 1 | 2 | 3 | 4;

interface BasicForm {
  name: string;
  contributionAmount: string;
  frequency: string;
  maxMembers: string;
  isPublic: boolean;
  isMultiAmount: boolean;
}

interface TypeConfig {
  // project
  vendorName?: string;
  goalAmount?: string;
  goalDescription?: string;
  releaseCondition?: string;
  // yield
  yieldRate?: string;
  // growth
  growthRate?: string;
  // hybrid
  rotationPct?: number;
  investmentPct?: number;
  solidarityPct?: number;
  yieldPct?: number;
  // business
  merchantId?: string;
}

export default function TontineCreate() {
  const [, navigate] = useLocation();
  const { token, user } = useAuth();

  const [step, setStep]       = useState<Step>(1);
  const [type, setType]       = useState("classic");
  const [basic, setBasic]     = useState<BasicForm>({
    name: "", contributionAmount: "", frequency: "monthly", maxMembers: "8",
    isPublic: true, isMultiAmount: false,
  });
  const [typeConfig, setTypeConfig] = useState<TypeConfig>({
    releaseCondition: "goal_reached",
    rotationPct: 60, investmentPct: 20, solidarityPct: 10, yieldPct: 10,
  });
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Hybrid pct helpers — always keep sum at 100
  const hybridSum = (typeConfig.rotationPct ?? 0) + (typeConfig.investmentPct ?? 0) +
    (typeConfig.solidarityPct ?? 0) + (typeConfig.yieldPct ?? 0);

  function updateHybrid(key: keyof TypeConfig, val: number) {
    setTypeConfig(c => ({ ...c, [key]: val }));
  }

  const createMut = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = {
        name:               basic.name.trim(),
        contributionAmount: Number(basic.contributionAmount),
        currency:           "XOF",
        frequency:          basic.frequency,
        maxMembers:         parseInt(basic.maxMembers),
        adminUserId:        user?.id,
        tontineType:        type,
        isPublic:           basic.isPublic,
        isMultiAmount:      basic.isMultiAmount,
      };

      if (type === "project") {
        body.goalAmount      = parseFloat(typeConfig.goalAmount ?? "0");
        body.goalDescription = typeConfig.goalDescription;
      }
      if (type === "yield")  body.yieldRate  = parseFloat(typeConfig.yieldRate ?? "0");
      if (type === "growth") body.growthRate = parseFloat(typeConfig.growthRate ?? "0");

      const tontine = await apiFetch<any>("/tontines", token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify(body),
      });

      const id = tontine.tontine?.id ?? tontine.id;
      setCreatedId(id);

      // Activate
      await apiFetch(`/community/tontines/${id}/activate`, token, {
        method: "POST",
        body: JSON.stringify({ adminUserId: user?.id }),
      });

      // Hybrid config
      if (type === "hybrid" && id) {
        await apiFetch(`/community/tontines/${id}/hybrid-config`, token, {
          method: "POST",
          body: JSON.stringify({
            rotation_pct:   typeConfig.rotationPct,
            investment_pct: typeConfig.investmentPct,
            solidarity_pct: typeConfig.solidarityPct,
            yield_pct:      typeConfig.yieldPct,
            rebalance_each_cycle: true,
          }),
        });
      }

      return id;
    },
    onSuccess: (id) => { navigate(`/tontines/${id}`); },
    onError: (e: any) => setError(e.message ?? "Erreur lors de la création"),
  });

  function validateStep(): string {
    if (step === 2) {
      if (!basic.name.trim())          return "Le nom est requis";
      if (!basic.contributionAmount || parseFloat(basic.contributionAmount) <= 0) return "Montant invalide";
      if (parseInt(basic.maxMembers) < 2) return "Minimum 2 membres";
    }
    if (step === 3 && type === "hybrid" && Math.abs(hybridSum - 100) > 0.5) {
      return `La somme doit être 100% (actuellement ${hybridSum}%)`;
    }
    return "";
  }

  function next() {
    const err = validateStep();
    if (err) { setError(err); return; }
    setError("");
    if (step === 3 || (step === 2 && !needsStep3)) {
      setStep(4);
    } else {
      setStep((s) => (s + 1) as Step);
    }
  }

  const needsStep3 = ["project", "yield", "growth", "hybrid", "business", "investment"].includes(type);

  // ── Step indicators ───────────────────────────────────────────────────────
  const totalSteps = needsStep3 ? 4 : 3;
  const currentStepNum = step === 4 ? totalSteps : step;

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      <TopBar showBack onBack={() => step === 1 ? navigate("/tontines") : setStep((s) => Math.max(1, s - 1) as Step)} title="Créer une Tontine" />

      {/* Progress bar */}
      <div className="px-4 py-3 bg-white border-b border-gray-100">
        <div className="flex items-center gap-2 max-w-lg mx-auto">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div key={i} className="flex-1 h-1.5 rounded-full transition-all"
              style={{ background: i < currentStepNum ? "#1A6B32" : "#E5E7EB" }}
            />
          ))}
          <span className="text-xs text-gray-500 flex-shrink-0">{currentStepNum}/{totalSteps}</span>
        </div>
      </div>

      <main key={`tc-step-${step}`} className="px-4 pt-5 max-w-lg mx-auto">
        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl text-sm flex items-center gap-2 text-red-700 bg-red-50">
            <AlertCircle size={15} /> {error}
          </div>
        )}

        {/* ── Step 1: Type Selection ─────────────────────────────────────── */}
        {step === 1 && (
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-1">Choisissez le type</h2>
            <p className="text-sm text-gray-500 mb-5">Sélectionnez la mécanique qui correspond à votre objectif</p>
            <div className="grid grid-cols-1 gap-2.5">
              {TYPES.map(t => (
                <TontineTypeCard key={t} type={t} selected={type === t} onClick={() => setType(t)} />
              ))}
            </div>
          </div>
        )}

        {/* ── Step 2: Basic Config ───────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-1">Configuration de base</h2>
            <p className="text-sm text-gray-500 mb-5">Définissez les paramètres principaux</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Nom de la tontine</label>
                <input type="text" value={basic.name} onChange={e => setBasic(b => ({ ...b, name: e.target.value }))}
                  placeholder="Ex: Tontine Solidarité Korhogo"
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2"
                  style={{ minHeight: 48 }} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Montant de cotisation (XOF)</label>
                <input type="number" inputMode="numeric" value={basic.contributionAmount}
                  onChange={e => setBasic(b => ({ ...b, contributionAmount: e.target.value }))}
                  placeholder="25 000"
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2"
                  style={{ minHeight: 48 }} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Fréquence</label>
                <div className="grid grid-cols-3 gap-2">
                  {FREQ_OPTIONS.map(opt => (
                    <button key={opt.value} type="button"
                      onClick={() => setBasic(b => ({ ...b, frequency: opt.value }))}
                      className="py-3 rounded-xl text-xs font-semibold border transition-all"
                      style={{
                        background: basic.frequency === opt.value ? "#F0FDF4" : "#F9FAFB",
                        borderColor: basic.frequency === opt.value ? "#1A6B32" : "#E5E7EB",
                        color: basic.frequency === opt.value ? "#1A6B32" : "#6B7280",
                        minHeight: 44,
                      }}>{opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombre de membres max</label>
                <input type="number" inputMode="numeric" min={2} max={100} value={basic.maxMembers}
                  onChange={e => setBasic(b => ({ ...b, maxMembers: e.target.value }))}
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2"
                  style={{ minHeight: 48 }} />
              </div>
              {/* Toggles */}
              <div className="space-y-3">
                {[
                  { key: "isPublic" as const,     label: "Tontine publique",    desc: "Visible dans 'Découvrir'" },
                  { key: "isMultiAmount" as const, label: "Multi-montants",      desc: "Chaque membre cotise un montant différent" },
                ].map(({ key, label, desc }) => (
                  <div key={key} className="flex items-center justify-between p-3.5 bg-white rounded-xl border border-gray-100">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{label}</p>
                      <p className="text-xs text-gray-500">{desc}</p>
                    </div>
                    <button type="button" onClick={() => setBasic(b => ({ ...b, [key]: !b[key] }))}
                      className="w-11 h-6 rounded-full transition-colors flex-shrink-0 relative"
                      style={{ background: basic[key] ? "#1A6B32" : "#D1D5DB" }}>
                      <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all"
                        style={{ left: basic[key] ? "calc(100% - 22px)" : "2px" }} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: Type-specific config ──────────────────────────────── */}
        {step === 3 && needsStep3 && (
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-1">
              Config {TYPE_META[type]?.icon} {TYPE_META[type]?.label}
            </h2>
            <p className="text-sm text-gray-500 mb-5">Paramètres spécifiques à ce type</p>
            <div key={type} className="space-y-4">

              {type === "project" && (<div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Nom du vendeur / fournisseur</label>
                  <input type="text" value={typeConfig.vendorName ?? ""}
                    onChange={e => setTypeConfig(c => ({ ...c, vendorName: e.target.value }))}
                    placeholder="Ex: Marché Dantokpa" className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none" style={{ minHeight: 48 }} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Montant objectif (XOF)</label>
                  <input type="number" inputMode="numeric" value={typeConfig.goalAmount ?? ""}
                    onChange={e => setTypeConfig(c => ({ ...c, goalAmount: e.target.value }))}
                    className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none" style={{ minHeight: 48 }} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Description de l'objectif</label>
                  <textarea value={typeConfig.goalDescription ?? ""}
                    onChange={e => setTypeConfig(c => ({ ...c, goalDescription: e.target.value }))}
                    rows={3} className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none resize-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Condition de déblocage</label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { value: "goal_reached", label: "Objectif atteint" },
                      { value: "date_reached", label: "Date fixée" },
                      { value: "vote",         label: "Vote" },
                    ].map(opt => (
                      <button key={opt.value} type="button"
                        onClick={() => setTypeConfig(c => ({ ...c, releaseCondition: opt.value }))}
                        className="py-2.5 rounded-xl text-xs font-semibold border transition-all"
                        style={{
                          background: typeConfig.releaseCondition === opt.value ? "#F0FDF4" : "#F9FAFB",
                          borderColor: typeConfig.releaseCondition === opt.value ? "#1A6B32" : "#E5E7EB",
                          color: typeConfig.releaseCondition === opt.value ? "#1A6B32" : "#6B7280",
                          minHeight: 40,
                        }}>{opt.label}</button>
                    ))}
                  </div>
                </div>
              </div>)}

              {type === "yield" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Taux de rendement (% annuel)</label>
                  <input type="number" inputMode="decimal" value={typeConfig.yieldRate ?? ""}
                    onChange={e => setTypeConfig(c => ({ ...c, yieldRate: e.target.value }))}
                    placeholder="5" min={0} max={50} step={0.5}
                    className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none" style={{ minHeight: 48 }} />
                  <p className="text-xs text-gray-500 mt-1.5">Les premiers membres à recevoir paient un intérêt au pool</p>
                </div>
              )}

              {type === "growth" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Taux de croissance par cycle (%)</label>
                  <input type="number" inputMode="decimal" value={typeConfig.growthRate ?? ""}
                    onChange={e => setTypeConfig(c => ({ ...c, growthRate: e.target.value }))}
                    placeholder="3" min={0} max={50} step={0.5}
                    className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none" style={{ minHeight: 48 }} />
                  <p className="text-xs text-gray-500 mt-1.5">La cotisation augmente de ce % à chaque cycle</p>
                </div>
              )}

              {type === "hybrid" && (
                <div className="space-y-4">
                  <div className="p-3 rounded-xl flex items-center justify-between"
                    style={{ background: Math.abs(hybridSum - 100) < 0.5 ? "#F0FDF4" : "#FEF2F2" }}>
                    <span className="text-sm font-semibold" style={{ color: Math.abs(hybridSum - 100) < 0.5 ? "#1A6B32" : "#DC2626" }}>
                      Total: {hybridSum}%
                    </span>
                    {Math.abs(hybridSum - 100) < 0.5
                      ? <Check size={16} className="text-green-700" />
                      : <AlertCircle size={16} className="text-red-600" />}
                  </div>
                  {([
                    { key: "rotationPct",   label: "Rotation classique",    color: "#1A6B32" },
                    { key: "investmentPct", label: "Investissement",         color: "#2563EB" },
                    { key: "solidarityPct", label: "Réserve solidarité",     color: "#7C3AED" },
                    { key: "yieldPct",      label: "Bonus rendement",         color: "#EA580C" },
                  ] as const).map(({ key, label, color }) => (
                    <div key={key}>
                      <div className="flex justify-between mb-1.5">
                        <label className="text-sm font-medium text-gray-700">{label}</label>
                        <span className="text-sm font-bold" style={{ color }}>{typeConfig[key] ?? 0}%</span>
                      </div>
                      <input type="range" min={0} max={100} step={5}
                        value={typeConfig[key] ?? 0}
                        onChange={e => updateHybrid(key, parseInt(e.target.value))}
                        className="w-full h-2 rounded-full appearance-none cursor-pointer"
                        style={{ accentColor: color }} />
                    </div>
                  ))}
                </div>
              )}

              {(type === "business" || type === "investment" || type === "diaspora" || type === "solidarity") && (
                <div className="text-center py-6">
                  <p className="text-sm text-gray-500">La configuration avancée pour ce type sera disponible après la création.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Step 4: Summary + Create ──────────────────────────────────── */}
        {step === 4 && (
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-1">Récapitulatif</h2>
            <p className="text-sm text-gray-500 mb-5">Vérifiez avant de créer</p>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm divide-y divide-gray-50">
              {[
                { label: "Type",        value: `${TYPE_META[type]?.icon} ${TYPE_META[type]?.label}` },
                { label: "Nom",         value: basic.name },
                { label: "Cotisation",  value: `${formatXOF(basic.contributionAmount || "0")} / ${FREQ_LABELS[basic.frequency]}` },
                { label: "Membres max", value: basic.maxMembers },
                { label: "Visibilité",  value: basic.isPublic ? "Publique" : "Privée" },
                ...(type === "yield" && typeConfig.yieldRate ? [{ label: "Taux rendement", value: `${typeConfig.yieldRate}%` }] : []),
                ...(type === "growth" && typeConfig.growthRate ? [{ label: "Taux croissance", value: `${typeConfig.growthRate}%` }] : []),
                ...(type === "hybrid" ? [{
                  label: "Répartition hybride",
                  value: `Rotation ${typeConfig.rotationPct}% · Invest. ${typeConfig.investmentPct}% · Solida. ${typeConfig.solidarityPct}% · Yield ${typeConfig.yieldPct}%`,
                }] : []),
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between px-4 py-3">
                  <span className="text-sm text-gray-500">{label}</span>
                  <span className="text-sm font-semibold text-gray-900 text-right max-w-[55%]">{value}</span>
                </div>
              ))}
            </div>

            {error && (
              <div className="mt-4 px-4 py-3 rounded-xl text-sm flex items-center gap-2 text-red-700 bg-red-50">
                <AlertCircle size={15} /> {error}
              </div>
            )}

            <button
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
              className="mt-6 w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 transition-opacity disabled:opacity-70"
              style={{ background: "#1A6B32", minHeight: 52 }}
            >
              {createMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
              Créer ma tontine
            </button>
          </div>
        )}
      </main>

      {/* Bottom nav buttons */}
      {step !== 4 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 p-4 z-40">
          <div className="max-w-lg mx-auto flex gap-3">
            {step > 1 && (
              <button onClick={() => setStep((s) => (s - 1) as Step)}
                className="flex items-center gap-1 px-4 py-3 rounded-xl border border-gray-200 text-sm font-semibold text-gray-700"
                style={{ minHeight: 48 }}>
                <ChevronLeft size={16} /> Retour
              </button>
            )}
            <button
              onClick={next}
              className="flex-1 py-3 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2"
              style={{ background: "#1A6B32", minHeight: 48 }}
            >
              {step === 2 && !needsStep3 ? "Vérifier" : "Continuer"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
