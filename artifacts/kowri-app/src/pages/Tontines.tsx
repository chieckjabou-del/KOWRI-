import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, generateIdempotencyKey } from "@/lib/api";
import { TontineCard, TontineCardSkeleton } from "@/components/TontineCard";
import { TopBar } from "@/components/TopBar";
import { BottomNav } from "@/components/BottomNav";

const FREQ_OPTIONS = [
  { value: "weekly",   label: "Hebdomadaire" },
  { value: "biweekly", label: "Bimensuel"    },
  { value: "monthly",  label: "Mensuel"      },
];

export default function Tontines() {
  const { token, user } = useAuth();
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);

  const [form, setForm] = useState({
    name: "", contributionAmount: "", frequency: "monthly", maxMembers: "8",
  });
  const [formError, setFormError] = useState("");

  const tontinesQ = useQuery({
    queryKey: ["tontines", user?.id],
    queryFn: () => apiFetch<any>(`/tontines?userId=${user?.id}&limit=30`, token),
    enabled: !!user?.id,
    staleTime: 15_000,
  });
  const tontines = tontinesQ.data?.tontines ?? [];

  const createMut = useMutation({
    mutationFn: async (data: typeof form) => {
      return apiFetch("/tontines", token, {
        method: "POST",
        headers: { "Idempotency-Key": generateIdempotencyKey() } as any,
        body: JSON.stringify({
          name: data.name,
          contributionAmount: parseFloat(data.contributionAmount),
          frequency: data.frequency,
          maxMembers: parseInt(data.maxMembers),
          createdBy: user?.id,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tontines", user?.id] });
      setShowModal(false);
      setForm({ name: "", contributionAmount: "", frequency: "monthly", maxMembers: "8" });
      setFormError("");
    },
    onError: (err: any) => setFormError(err.message ?? "Erreur lors de la création"),
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.contributionAmount) {
      setFormError("Tous les champs sont requis");
      return;
    }
    createMut.mutate(form);
  }

  return (
    <div className="min-h-screen pb-20" style={{ background: "#FAFAF8" }}>
      <TopBar title="Mes Tontines" />

      <main className="px-4 pt-5 pb-4 max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-2xl font-bold text-gray-900">Mes Tontines</h1>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-white text-sm"
            style={{ background: "#1A6B32", minHeight: 44 }}
          >
            <Plus size={16} />
            Créer
          </button>
        </div>

        <div className="space-y-3">
          {tontinesQ.isLoading && [0,1,2].map(i => <TontineCardSkeleton key={i} />)}
          {!tontinesQ.isLoading && tontines.length === 0 && (
            <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-gray-100">
              <div
                className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center"
                style={{ background: "#F0FDF4" }}
              >
                <span className="text-2xl">🤝</span>
              </div>
              <p className="font-semibold text-gray-900 mb-1">Aucune tontine</p>
              <p className="text-sm text-gray-500 mb-5">
                Rejoignez une tontine ou créez la vôtre pour épargner ensemble
              </p>
              <button
                onClick={() => setShowModal(true)}
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-white text-sm"
                style={{ background: "#1A6B32", minHeight: 44 }}
              >
                <Plus size={16} />
                Nouvelle Tontine
              </button>
            </div>
          )}
          {tontines.map((t: any) => (
            <TontineCard key={t.id} id={t.id} name={t.name}
              contributionAmount={t.contributionAmount} frequency={t.frequency}
              maxMembers={t.maxMembers} status={t.status}
              currentRound={t.currentRound} totalRounds={t.maxMembers}
              nextPayoutAt={t.nextPayoutAt}
            />
          ))}
        </div>
      </main>

      <BottomNav />

      {/* Create tontine modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowModal(false)} />
          <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pb-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-gray-900">Nouvelle Tontine</h2>
              <button onClick={() => setShowModal(false)} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            {formError && (
              <div className="mb-4 px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                {formError}
              </div>
            )}

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Nom de la tontine</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Ex: Tontine Baara"
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ minHeight: 48 }}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Montant de cotisation (FCFA)</label>
                <input
                  type="number"
                  value={form.contributionAmount}
                  onChange={e => setForm(f => ({ ...f, contributionAmount: e.target.value }))}
                  placeholder="5000"
                  inputMode="numeric"
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ minHeight: 48 }}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Fréquence</label>
                <div className="grid grid-cols-3 gap-2">
                  {FREQ_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, frequency: opt.value }))}
                      className="py-3 rounded-xl text-xs font-semibold border transition-all"
                      style={{
                        background: form.frequency === opt.value ? "#F0FDF4" : "#F9FAFB",
                        borderColor: form.frequency === opt.value ? "#1A6B32" : "#E5E7EB",
                        color: form.frequency === opt.value ? "#1A6B32" : "#6B7280",
                        minHeight: 44,
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Nombre de membres</label>
                <input
                  type="number"
                  value={form.maxMembers}
                  onChange={e => setForm(f => ({ ...f, maxMembers: e.target.value }))}
                  min={2} max={50}
                  inputMode="numeric"
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ minHeight: 48 }}
                />
              </div>

              <button
                type="submit"
                disabled={createMut.isPending}
                className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 transition-opacity disabled:opacity-70"
                style={{ background: "#1A6B32", minHeight: 52 }}
              >
                {createMut.isPending && <Loader2 size={16} className="animate-spin" />}
                Créer la tontine
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
