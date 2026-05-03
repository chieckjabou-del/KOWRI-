import { Link } from "wouter";
import { Users, ChevronRight } from "lucide-react";
import { formatXOF } from "@/lib/api";

interface TontineCardProps {
  id: string;
  name: string;
  contributionAmount: string | number;
  frequency: string;
  maxMembers: number;
  status: string;
  currentRound?: number;
  totalRounds?: number;
  nextPayoutAt?: string | null;
  memberCount?: number;
  compact?: boolean;
}

const STATUS_LABELS: Record<string, { label: string; bg: string; color: string }> = {
  active:    { label: "Actif",    bg: "#F0FDF4", color: "#16A34A" },
  pending:   { label: "En attente", bg: "#FFFBEB", color: "#D97706" },
  completed: { label: "Terminé", bg: "#F3F4F6", color: "#6B7280" },
  paused:    { label: "Pausé",   bg: "#FEF2F2", color: "#DC2626" },
};

const FREQ_LABELS: Record<string, string> = {
  weekly:    "hebdomadaire",
  biweekly:  "bimensuel",
  monthly:   "mensuel",
};

export function TontineCard({
  id, name, contributionAmount, frequency, maxMembers,
  status, currentRound, totalRounds, nextPayoutAt, memberCount, compact,
}: TontineCardProps) {
  const s = STATUS_LABELS[status] ?? STATUS_LABELS.pending;
  const progress = totalRounds && currentRound ? (currentRound / totalRounds) * 100 : 0;
  const rounds = totalRounds ?? maxMembers;
  const current = currentRound ?? 0;

  return (
    <Link href={`/tontines/${id}`}>
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "#F0FDF4" }}>
              <Users size={15} style={{ color: "#1A6B32" }} />
            </div>
            <div>
              <p className="font-semibold text-gray-900 text-sm">{name}</p>
              <p className="text-xs text-gray-500">
                Tour {current}/{rounds} · {formatXOF(contributionAmount)} {FREQ_LABELS[frequency] ?? frequency}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: s.bg, color: s.color }}>
              {s.label}
            </span>
            {!compact && <ChevronRight size={16} className="text-gray-400" />}
          </div>
        </div>

        {!compact && (
          <>
            <div className="mb-2">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>Collecte du tour</span>
                <span>{current}/{rounds} membres</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: "#F3F4F6" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${Math.min(progress, 100)}%`, background: "#1A6B32" }}
                />
              </div>
            </div>

            {nextPayoutAt && (
              <p className="text-xs text-gray-500">
                Prochain versement : <span className="font-medium text-gray-700">
                  {new Date(nextPayoutAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}
                </span>
              </p>
            )}
          </>
        )}
      </div>
    </Link>
  );
}

export function TontineCardSkeleton() {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 animate-pulse">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-full bg-gray-100" />
        <div>
          <div className="h-3.5 w-32 bg-gray-100 rounded mb-2" />
          <div className="h-3 w-24 bg-gray-100 rounded" />
        </div>
      </div>
      <div className="h-2 w-full bg-gray-100 rounded mb-2" />
      <div className="h-3 w-40 bg-gray-100 rounded" />
    </div>
  );
}
