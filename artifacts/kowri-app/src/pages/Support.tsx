import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronLeft, Plus, X, Loader2, CheckCircle2, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { BottomNav } from "@/components/BottomNav";

const CATEGORIES = [
  { value: "TRANSACTION_ISSUE", label: "💳 Problème de transaction" },
  { value: "ACCOUNT_LOCKED",    label: "🔒 Compte bloqué" },
  { value: "WRONG_AMOUNT",      label: "💸 Montant incorrect" },
  { value: "AGENT_COMPLAINT",   label: "🏪 Plainte sur agent" },
  { value: "APP_BUG",           label: "🐛 Bug de l'application" },
  { value: "OTHER",             label: "❓ Autre" },
];

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  OPEN:        { label: "Ouvert",       bg: "#FFFBEB", color: "#D97706" },
  IN_PROGRESS: { label: "En cours",    bg: "#EFF6FF", color: "#2563EB" },
  RESOLVED:    { label: "Résolu ✅",   bg: "#F0FDF4", color: "#16A34A" },
  CLOSED:      { label: "Fermé",       bg: "#F3F4F6", color: "#6B7280" },
};

const INPUT_CLS = "w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-gray-900 text-sm focus:outline-none focus:border-[#1A6B32] transition-colors";

function TicketRow({ ticket }: { ticket: any }) {
  const [open, setOpen] = useState(false);
  const s = STATUS_CONFIG[ticket.status] ?? STATUS_CONFIG.OPEN;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full px-4 py-4 flex items-start gap-3 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono font-bold text-gray-400">
              {ticket.ticketNumber ?? ticket.id?.slice(0, 8)}
            </span>
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{ background: s.bg, color: s.color }}
            >
              {s.label}
            </span>
          </div>
          <p className="font-semibold text-gray-900 text-sm truncate">{ticket.title}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {new Date(ticket.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}
          </p>
        </div>
        {open ? <ChevronUp size={16} className="text-gray-400 flex-shrink-0 mt-1" /> : <ChevronDown size={16} className="text-gray-400 flex-shrink-0 mt-1" />}
      </button>

      {open ? (
        <div className="px-4 pb-4 pt-0 border-t border-gray-50">
          <p className="text-sm text-gray-700 leading-relaxed mt-3">{ticket.description}</p>
          {ticket.resolution ? (
            <div className="mt-3 rounded-xl p-3" style={{ background: "#F0FDF4" }}>
              <p className="text-xs font-semibold text-green-800 mb-1">Réponse KOWRI</p>
              <p className="text-xs text-green-700">{ticket.resolution}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function Support() {
  const { token, user } = useAuth();
  const qc = useQueryClient();

  const [showForm, setShowForm]   = useState(false);
  const [category, setCategory]   = useState("TRANSACTION_ISSUE");
  const [title, setTitle]         = useState("");
  const [description, setDescription] = useState("");
  const [txId, setTxId]           = useState("");
  const [formError, setFormError] = useState("");
  const [done, setDone]           = useState<string | null>(null);

  const ticketsQ = useQuery({
    queryKey: ["support-tickets", user?.id],
    queryFn:  () => apiFetch<any>(`/support/tickets?userId=${user?.id}`, token),
    enabled:  !!user?.id,
    staleTime: 30_000,
  });

  const tickets: any[] = Array.isArray(ticketsQ.data?.tickets) ? ticketsQ.data.tickets : [];

  const createMut = useMutation({
    mutationFn: () => {
      if (!title.trim())       throw new Error("Entrez un titre");
      if (!description.trim()) throw new Error("Décrivez votre problème");
      return apiFetch<any>("/support/tickets", token, {
        method: "POST",
        body: JSON.stringify({
          userId: user?.id,
          category,
          title: title.trim(),
          description: description.trim(),
          relatedTransactionId: txId.trim() || undefined,
        }),
      });
    },
    onSuccess: (data) => {
      setDone(data?.ticket?.ticketNumber ?? data?.ticketNumber ?? "TKT-???");
      qc.invalidateQueries({ queryKey: ["support-tickets", user?.id] });
    },
    onError: (e: any) => setFormError(e.message ?? "Soumission échouée"),
  });

  function openForm() {
    setTitle(""); setDescription(""); setTxId(""); setFormError(""); setDone(null);
    setCategory("TRANSACTION_ISSUE");
    setShowForm(true);
  }

  return (
    <div className="min-h-screen pb-24" style={{ background: "#FAFAF8" }}>
      {/* Header */}
      <div className="sticky top-0 z-30 px-4 pt-12 pb-4 bg-white border-b border-gray-100">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          <Link href="/profile">
            <button className="p-2 rounded-full hover:bg-gray-100">
              <ChevronLeft size={22} className="text-gray-700" />
            </button>
          </Link>
          <div className="flex-1">
            <h1 className="font-bold text-gray-900 text-lg">Support KOWRI</h1>
            <p className="text-xs text-gray-500">Nous vous répondons sous 24h</p>
          </div>
          <button
            onClick={openForm}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2.5 rounded-xl text-white"
            style={{ background: "#1A6B32", minHeight: 40 }}
          >
            <Plus size={14} /> Nouveau
          </button>
        </div>
      </div>

      <main className="px-4 pt-5 pb-4 max-w-lg mx-auto space-y-4">
        {ticketsQ.isLoading ? (
          <div className="space-y-3">
            {[0,1,2].map(i => <div key={i} className="h-20 bg-white rounded-2xl animate-pulse border border-gray-100" />)}
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <MessageSquare size={40} className="text-gray-300 mb-4" />
            <p className="font-bold text-gray-900 mb-1">Aucun ticket ouvert</p>
            <p className="text-sm text-gray-500 mb-5">Un problème ? Notre équipe est là pour vous aider.</p>
            <button
              onClick={openForm}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-bold text-white text-sm"
              style={{ background: "#1A6B32", minHeight: 44 }}
            >
              <Plus size={15} /> Créer un ticket
            </button>
          </div>
        ) : (
          tickets.map((t: any) => <TicketRow key={t.id} ticket={t} />)
        )}
      </main>

      <BottomNav />

      {/* Create ticket modal */}
      {showForm ? (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowForm(false)} />
          <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pb-8 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-bold text-gray-900">
                {done ? "Ticket soumis !" : "Créer un ticket"}
              </h2>
              <button onClick={() => setShowForm(false)} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100">
                <X size={20} className="text-gray-500" />
              </button>
            </div>

            {done ? (
              <div className="text-center py-6">
                <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F0FDF4" }}>
                  <CheckCircle2 size={32} style={{ color: "#1A6B32" }} />
                </div>
                <p className="font-bold text-gray-900 text-lg mb-1">{done}</p>
                <p className="text-sm text-gray-500 mb-6">Nous vous répondrons sous 24h par notification.</p>
                <button
                  onClick={() => setShowForm(false)}
                  className="w-full py-3 rounded-xl font-bold text-white"
                  style={{ background: "#1A6B32" }}
                >
                  Fermer
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Category */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Catégorie</label>
                  <div className="grid grid-cols-2 gap-2">
                    {CATEGORIES.map(c => (
                      <button
                        key={c.value}
                        onClick={() => setCategory(c.value)}
                        className="text-left px-3 py-2.5 rounded-xl border text-xs font-semibold transition-all"
                        style={{
                          background:   category === c.value ? "#F0FDF4" : "#F9FAFB",
                          borderColor:  category === c.value ? "#1A6B32" : "#E5E7EB",
                          color:        category === c.value ? "#1A6B32" : "#6B7280",
                          minHeight: 44,
                        }}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Titre</label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="Ex: Mon transfert n'est pas arrivé"
                    className={INPUT_CLS}
                    style={{ minHeight: 48 }}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Décrivez votre problème en détail…"
                    rows={4}
                    className={INPUT_CLS}
                    style={{ resize: "none" }}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Référence transaction (optionnel)
                  </label>
                  <input
                    type="text"
                    value={txId}
                    onChange={e => setTxId(e.target.value)}
                    placeholder="ID ou référence de la transaction"
                    className={INPUT_CLS}
                    style={{ minHeight: 48 }}
                  />
                </div>

                {formError ? (
                  <div className="px-4 py-3 rounded-xl text-sm font-medium" style={{ background: "#FEF2F2", color: "#DC2626" }}>
                    {formError}
                  </div>
                ) : null}

                <button
                  onClick={() => { setFormError(""); createMut.mutate(); }}
                  disabled={createMut.isPending}
                  className="w-full py-4 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 disabled:opacity-60"
                  style={{ background: "#1A6B32", minHeight: 52 }}
                >
                  {createMut.isPending ? <Loader2 size={16} className="animate-spin" /> : null}
                  Soumettre le ticket
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
