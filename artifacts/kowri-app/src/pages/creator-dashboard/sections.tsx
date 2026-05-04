import { CheckCircle2, Coins, Copy, Flame, Sparkles, Trophy, Users } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyHint, SkeletonCard } from "@/components/premium/PremiumStates";
import { formatXOF } from "@/lib/api";
import type { CreatorRankingRow, CreatorTontineRevenueRow, DailyGoal, LevelConfig } from "./useCreatorDashboardData";

export function IntroViralCard({
  averageFeeRate,
  hundredMembersVisual,
}: {
  averageFeeRate: number;
  hundredMembersVisual: number;
}) {
  return (
    <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
      <CardContent className="space-y-3 pt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">UX virale</p>
        <p className="text-sm font-semibold text-black">
          Chaque membre qui rejoint ta tontine te rapporte environ {averageFeeRate.toFixed(0)}%
          {" "}sur les contributions enregistrees.
        </p>
        <p className="text-xs text-gray-500">
          Simulation visuelle: si tu ajoutes 100 personnes sur un tour de reference,
          tu peux generer {formatXOF(hundredMembersVisual)} de commission createur.
        </p>
      </CardContent>
    </Card>
  );
}

export function DailyLoopCard({
  streak,
  goalsCompleted,
  dailyGoals,
}: {
  streak: number;
  goalsCompleted: number;
  dailyGoals: DailyGoal[];
}) {
  return (
    <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base font-semibold">Boucle de retour journaliere</CardTitle>
        <div className="flex items-center gap-1.5 rounded-full border border-orange-100 bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-700">
          <Flame className="h-3.5 w-3.5" />
          Streak {streak}j
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-2xl border border-gray-100 bg-gray-50 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Objectifs du jour</p>
          <p className="mt-1 text-sm font-semibold text-black">
            {goalsCompleted}/3 completes. Reviens demain pour prolonger ta serie.
          </p>
        </div>
        <div className="space-y-2">
          {dailyGoals.map((goal) => (
            <div key={goal.id} className="rounded-xl border border-gray-100 bg-white px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-black">{goal.label}</p>
                {goal.done ? (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    OK
                  </span>
                ) : null}
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-gray-100">
                <div
                  className={`h-1.5 rounded-full ${goal.done ? "bg-emerald-600" : "bg-black"}`}
                  style={{
                    width: `${Math.min(100, Math.max(0, (goal.progress / Math.max(goal.target, 1)) * 100))}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                {goal.progress >= goal.target
                  ? `Objectif atteint (${goal.progress}/${goal.target}).`
                  : `Encore ${Math.max(goal.target - goal.progress, 0)} pour valider.`}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function LevelCard({
  currentLevel,
  shareBurst,
  reputationScore,
  progressPercent,
  nextLevelLabel,
  pointsToNext,
  primaryBadge,
  dynamicMessage,
}: {
  currentLevel: LevelConfig;
  shareBurst: boolean;
  reputationScore: number;
  progressPercent: number;
  nextLevelLabel: string | null;
  pointsToNext: number;
  primaryBadge: { label: string; description: string } | null;
  dynamicMessage: string;
}) {
  return (
    <Card className={`premium-card rounded-3xl border ${currentLevel.cardClass} shadow-sm`}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base font-semibold">Niveau createur visible</CardTitle>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${currentLevel.accentClass} ${
            shareBurst ? "badge-pop" : ""
          }`}
        >
          {currentLevel.label}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-3">
          <p className="text-xs text-gray-500">Score actuel</p>
          <p className="mt-1 text-2xl font-black text-black">{reputationScore}</p>
          <div className="mt-3 h-2 rounded-full bg-gray-100">
            <div
              className="h-2 rounded-full bg-black transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-gray-600">
            {nextLevelLabel
              ? `Encore ${pointsToNext} points pour passer au niveau ${nextLevelLabel}.`
              : "Niveau maximal atteint. Continue pour garder ton avance."}
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-2xl border border-gray-100 bg-white px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Badge principal</p>
            {primaryBadge ? (
              <div className={`mt-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 ${shareBurst ? "badge-pop" : ""}`}>
                <p className="text-sm font-semibold text-amber-700">{primaryBadge.label}</p>
                <p className="mt-1 text-xs text-amber-700/85">{primaryBadge.description}</p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-gray-500">
                Aucun badge debloque pour l'instant. Continue les cycles pour en activer.
              </p>
            )}
          </div>
          <div className="rounded-2xl border border-gray-100 bg-white px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Message dynamique</p>
            <p className="mt-2 text-sm font-semibold text-black">{dynamicMessage}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function MetricsGrid({
  totalEarnings,
  totalMembersInTontines,
  totalTontines,
  totalVolume,
}: {
  totalEarnings: number;
  totalMembersInTontines: number;
  totalTontines: number;
  totalVolume: number;
}) {
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <MetricCard
        label="Gains createur (reels)"
        value={formatXOF(totalEarnings)}
        icon={<Coins className="h-4 w-4" />}
      />
      <MetricCard
        label="Membres dans tes tontines"
        value={`${totalMembersInTontines}`}
        icon={<Users className="h-4 w-4" />}
      />
      <MetricCard
        label="Tontines creees"
        value={`${totalTontines}`}
        icon={<Sparkles className="h-4 w-4" />}
      />
      <MetricCard
        label="Volume communaute"
        value={formatXOF(totalVolume)}
        icon={<Coins className="h-4 w-4" />}
      />
    </section>
  );
}

export function MoneyFocusCard({
  shareBurst,
  dailyGain,
  mainMoneyValue,
  totalGenerated,
  hundredMembersVisual,
}: {
  shareBurst: boolean;
  dailyGain: number;
  mainMoneyValue: number;
  totalGenerated: number;
  hundredMembersVisual: number;
}) {
  return (
    <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">Money focus</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={`rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-4 ${shareBurst || dailyGain > 0 ? "gain-pulse" : ""}`}>
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Aujourd'hui tu as gagne</p>
          <p className="mt-1 text-3xl font-black tracking-tight text-emerald-800">{formatXOF(mainMoneyValue)}</p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-2xl border border-gray-100 bg-white px-3 py-3">
            <p className="text-xs text-gray-500">Total genere</p>
            <p className="mt-1 text-lg font-bold text-black">{formatXOF(totalGenerated)}</p>
          </div>
          <div className="rounded-2xl border border-gray-100 bg-white px-3 py-3">
            <p className="text-xs text-gray-500">Projection 100 membres</p>
            <p className="mt-1 text-lg font-bold text-black">{formatXOF(hundredMembersVisual)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ReputationCard({
  isLoading,
  score,
  tier,
  badgeCount,
  badges,
}: {
  isLoading: boolean;
  score: number;
  tier: string;
  badgeCount: number;
  badges: Array<{ badge: string; label: string }>;
}) {
  return (
    <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base font-semibold">Gamification performance</CardTitle>
        <Trophy className="h-4 w-4 text-amber-500" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <SkeletonCard rows={2} className="bg-transparent px-0 py-0 shadow-none border-none" />
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-center">
                <p className="text-gray-500">Score</p>
                <p className="font-bold text-gray-900">{score}</p>
              </div>
              <div className="rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-center">
                <p className="text-gray-500">Tier</p>
                <p className="font-bold text-gray-900">{tier || "new"}</p>
              </div>
              <div className="rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-center">
                <p className="text-gray-500">Badges</p>
                <p className="font-bold text-gray-900">{badgeCount}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {badges.slice(0, 4).map((badge) => (
                <span
                  key={badge.badge}
                  className="rounded-full border border-amber-100 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700"
                >
                  {badge.label}
                </span>
              ))}
              {badges.length === 0 ? (
                <span className="text-xs text-gray-500">
                  Les badges apparaîtront après progression continue des cycles.
                </span>
              ) : null}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function TontineRevenueCard({
  isLoading,
  rows,
}: {
  isLoading: boolean;
  rows: CreatorTontineRevenueRow[];
}) {
  return (
    <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base font-semibold">Revenus generes par tontine</CardTitle>
        <Link href="/tontine">
          <Button className="press-feedback rounded-xl bg-black text-white hover:bg-black/90">
            Creer une tontine et gagner de l'argent
          </Button>
        </Link>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <SkeletonCard rows={5} className="bg-transparent px-0 py-0 shadow-none border-none" />
        ) : rows.length === 0 ? (
          <EmptyHint
            title="Aucune tontine reliee a tes communautes"
            description="Cree une tontine et active le mode createur pour monetiser les contributions."
            action={
              <Link href="/tontine">
                <Button className="press-feedback rounded-xl bg-black text-white hover:bg-black/90">
                  Creer une tontine
                </Button>
              </Link>
            }
          />
        ) : (
          rows.map((row) => (
            <Link key={row.id} href={`/tontine/${row.id}`}>
              <div className="premium-hover cursor-pointer rounded-2xl border border-gray-100 bg-white px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-black">{row.name}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {row.communityName} • {row.memberCount} membres • statut {row.status}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      Cotisation: {formatXOF(row.contributionAmount)} • Taux: {row.creatorFeeRate.toFixed(0)}%
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                      Gain creeateur
                    </p>
                    <p className="text-sm font-bold text-emerald-700">
                      {formatXOF(row.estimatedCreatorRevenue)}
                    </p>
                  </div>
                </div>
                <div className="mt-2 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  Total contribue (endpoint /tontines/:id): {formatXOF(row.totalContributed)}
                </div>
              </div>
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function RankingCard({
  isLoading,
  rankingRows,
}: {
  isLoading: boolean;
  rankingRows: CreatorRankingRow[];
}) {
  return (
    <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base font-semibold">Top createurs (pression sociale)</CardTitle>
        <Sparkles className="h-4 w-4 text-gray-500" />
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <SkeletonCard rows={3} className="bg-transparent px-0 py-0 shadow-none border-none" />
        ) : rankingRows.length === 0 ? (
          <EmptyHint
            title="Classement indisponible"
            description="Le classement se mettra a jour automatiquement quand plus de donnees seront visibles."
          />
        ) : (
          rankingRows.map((row, index) => (
            <div key={row.id} className="premium-hover rounded-2xl border border-gray-100 bg-white px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-black">
                    #{index + 1} {row.label}
                    {row.isYou ? " • toi" : ""}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Earnings {formatXOF(row.earnings)} • Membres {row.members} • Score {row.score}
                  </p>
                </div>
                <div className="rounded-full bg-black px-2.5 py-1 text-xs font-semibold text-white">
                  {row.points} pts
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function InviteCard({
  isEmpty,
  creatorFeeRate,
  invitedCount,
  nextInviteGoal,
  selectedId,
  options,
  inviteLink,
  estimatedRevenue,
  onSelect,
  onShare,
  shareBurst,
  shareCount,
}: {
  isEmpty: boolean;
  creatorFeeRate: number;
  invitedCount: number;
  nextInviteGoal: number;
  selectedId: string;
  options: CreatorTontineRevenueRow[];
  inviteLink: string;
  estimatedRevenue: number;
  onSelect: (value: string) => void;
  onShare: () => Promise<void>;
  shareBurst: boolean;
  shareCount: number;
}) {
  return (
    <Card className="premium-card rounded-3xl border-black/5 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base font-semibold">Inviter des membres</CardTitle>
        <Sparkles className="h-4 w-4 text-gray-500" />
      </CardHeader>
      <CardContent className="space-y-3">
        {isEmpty ? (
          <EmptyHint
            title="Aucune tontine à partager"
            description="Crée une tontine puis active le mode créateur pour lancer ta boucle virale."
          />
        ) : (
          <>
            <p className="text-xs text-gray-500">
              Chaque personne que tu ajoutes te rapporte {creatorFeeRate.toFixed(0)}% sur les collectes.
            </p>
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-700">
              <p className="font-semibold text-black">Tu as invite {invitedCount} personnes</p>
              <p className="mt-0.5">
                Invite 10 personnes de plus pour viser {formatXOF(nextInviteGoal)} de gain potentiel.
              </p>
            </div>
            <select
              value={selectedId}
              onChange={(event) => onSelect(event.target.value)}
              className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm"
            >
              {options.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} ({row.memberCount} membres)
                </option>
              ))}
            </select>
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600 break-all">
              {inviteLink}
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-xl border border-gray-100 bg-white px-3 py-2 text-center">
                <p className="text-gray-500">Membres</p>
                <p className="font-bold text-gray-900">{invitedCount}</p>
              </div>
              <div className="rounded-xl border border-gray-100 bg-white px-3 py-2 text-center">
                <p className="text-gray-500">Gains estimes</p>
                <p className="font-bold text-emerald-700">{formatXOF(estimatedRevenue)}</p>
              </div>
              <div className="rounded-xl border border-gray-100 bg-white px-3 py-2 text-center">
                <p className="text-gray-500">Gains reels</p>
                <p className="font-bold text-gray-900">{formatXOF(estimatedRevenue)}</p>
              </div>
            </div>
            <Button
              className={`press-feedback w-full rounded-xl bg-black text-white hover:bg-black/90 ${shareBurst ? "gain-pulse" : ""}`}
              onClick={() => {
                void onShare();
              }}
            >
              <Copy className="h-4 w-4" />
              Partager ma tontine
            </Button>
            <p className="text-[11px] text-gray-500">
              Partages copies: {shareCount}. Feedback instantane actif (toast + animation).
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MetricCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="premium-card premium-hover rounded-2xl border-black/5 shadow-sm">
      <CardContent className="space-y-1.5 p-4">
        <div className="text-gray-500">{icon}</div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</p>
        <p className="text-sm font-semibold text-black">{value}</p>
      </CardContent>
    </Card>
  );
}
