import { ApiError, apiFetch, generateIdempotencyKey } from "@/lib/api";
import type {
  TontineListItem,
  TontineMember,
  TontineOverview,
  TontineTimelineEvent,
  TontineFrequency,
} from "@/types/akwe";

interface CreateTontineInput {
  name: string;
  contributionAmount: number;
  maxMembers: number;
  frequency: TontineFrequency;
  tontineType: string;
  description?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function formatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Date a confirmer";
  }
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function reliabilityFromMember(raw: Record<string, unknown>, currentRound: number): TontineMember {
  const contributions = asNumber(raw.contributionsCount, 0);
  const hasReceived = Boolean(raw.hasReceivedPayout);
  const payoutOrder = asNumber(raw.payoutOrder, 1);
  const reliabilityScore = clamp(45 + contributions * 9 + (hasReceived ? 8 : 0), 25, 98);

  let reliabilityLabel: TontineMember["reliabilityLabel"] = "good";
  if (reliabilityScore >= 80) reliabilityLabel = "excellent";
  if (reliabilityScore < 60) reliabilityLabel = "watch";

  const shouldHavePaidForRound = Math.max(currentRound - 1, 0);
  const paymentStatus: TontineMember["paymentStatus"] =
    contributions >= shouldHavePaidForRound ? "paid" : "late";

  return {
    userId: asString(raw.userId, `member-${payoutOrder}`),
    userName: asString(raw.userName, `Membre ${payoutOrder}`),
    payoutOrder,
    contributionsCount: contributions,
    hasReceivedPayout: hasReceived,
    reliabilityScore,
    reliabilityLabel,
    paymentStatus,
  };
}

function makeTimelineFromSchedule(
  scheduleRows: Record<string, unknown>[] | undefined,
  currentRound: number,
): TontineTimelineEvent[] {
  if (!scheduleRows || scheduleRows.length === 0) {
    return [];
  }
  return scheduleRows.map((row, index) => {
    const round = asNumber(row.round, index + 1);
    const dateLabel = formatDateLabel(asString(row.scheduledDate));
    const status: TontineTimelineEvent["status"] =
      round < currentRound ? "done" : round === currentRound ? "current" : "upcoming";

    return {
      id: `timeline-${round}`,
      title: `Tour ${round}`,
      subtitle: `Versement prevu pour ${asString(row.userId, "membre")}`,
      status,
      dateLabel,
    };
  });
}

function buildMockTontines(): TontineListItem[] {
  return [
    {
      id: "mock-tontine-a",
      name: "Solidarite Famille",
      status: "active",
      frequency: "monthly",
      tontineType: "solidarity",
      contributionAmount: 50000,
      memberCount: 8,
      maxMembers: 10,
      currentRound: 3,
      totalRounds: 10,
      nextPayoutDate: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    },
    {
      id: "mock-tontine-b",
      name: "Investissement Commerce",
      status: "pending",
      frequency: "weekly",
      tontineType: "investment",
      contributionAmount: 15000,
      memberCount: 5,
      maxMembers: 12,
      currentRound: 0,
      totalRounds: 12,
      nextPayoutDate: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    },
  ];
}

function buildMockOverview(tontineId: string): TontineOverview {
  const currentRound = 3;
  const members: TontineMember[] = [
    {
      userId: "u1",
      userName: "Awa Traore",
      payoutOrder: 1,
      contributionsCount: 3,
      hasReceivedPayout: true,
      reliabilityScore: 92,
      reliabilityLabel: "excellent",
      paymentStatus: "paid",
    },
    {
      userId: "u2",
      userName: "Seydou Ouedraogo",
      payoutOrder: 2,
      contributionsCount: 3,
      hasReceivedPayout: true,
      reliabilityScore: 88,
      reliabilityLabel: "excellent",
      paymentStatus: "paid",
    },
    {
      userId: "u3",
      userName: "Fatou Diallo",
      payoutOrder: 3,
      contributionsCount: 2,
      hasReceivedPayout: false,
      reliabilityScore: 64,
      reliabilityLabel: "good",
      paymentStatus: "late",
    },
    {
      userId: "u4",
      userName: "Kader Ilboudo",
      payoutOrder: 4,
      contributionsCount: 3,
      hasReceivedPayout: false,
      reliabilityScore: 79,
      reliabilityLabel: "good",
      paymentStatus: "paid",
    },
  ];

  const timeline: TontineTimelineEvent[] = [
    {
      id: "r1",
      title: "Tour 1",
      subtitle: "Payout verse a Awa Traore",
      status: "done",
      dateLabel: formatDateLabel(new Date(Date.now() - 58 * 86_400_000).toISOString()),
    },
    {
      id: "r2",
      title: "Tour 2",
      subtitle: "Payout verse a Seydou Ouedraogo",
      status: "done",
      dateLabel: formatDateLabel(new Date(Date.now() - 30 * 86_400_000).toISOString()),
    },
    {
      id: "r3",
      title: "Tour 3",
      subtitle: "Prochaine beneficiaire: Fatou Diallo",
      status: "current",
      dateLabel: formatDateLabel(new Date(Date.now() + 4 * 86_400_000).toISOString()),
    },
  ];

  return {
    id: tontineId,
    name: "Solidarite Famille",
    status: "active",
    frequency: "monthly",
    tontineType: "solidarity",
    contributionAmount: 50000,
    currentRound,
    totalRounds: 10,
    memberCount: 8,
    maxMembers: 10,
    nextReceiver: members[2],
    nextPayoutDate: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    members,
    timeline,
    history: timeline.filter((item) => item.status === "done"),
    notifications: [
      "2 cotisations sont en retard cette semaine.",
      "Prochaine distribution planifiee dans 4 jours.",
    ],
  };
}

function mapTontineList(rawRows: unknown[]): TontineListItem[] {
  return rawRows.map((row, index) => {
    const raw = row as Record<string, unknown>;
    return {
      id: asString(raw.id, `tontine-${index}`),
      name: asString(raw.name, "Tontine"),
      status: (asString(raw.status, "pending") as TontineListItem["status"]) ?? "pending",
      frequency: (asString(raw.frequency, "monthly") as TontineFrequency) ?? "monthly",
      tontineType: asString(raw.tontineType, "classic"),
      contributionAmount: asNumber(raw.contributionAmount, 0),
      memberCount: asNumber(raw.memberCount, 0),
      maxMembers: asNumber(raw.maxMembers, 0),
      currentRound: asNumber(raw.currentRound, 0),
      totalRounds: asNumber(raw.totalRounds, asNumber(raw.maxMembers, 0)),
      nextPayoutDate: raw.nextPayoutDate ? asString(raw.nextPayoutDate) : null,
    };
  });
}

export async function listUserTontines(
  token: string | null,
): Promise<{ tontines: TontineListItem[]; usingMock: boolean }> {
  try {
    const data = await apiFetch<{ tontines?: unknown[] }>("/tontines?limit=50", token);
    const tontines = mapTontineList(data.tontines ?? []);
    if (tontines.length === 0) {
      return { tontines: buildMockTontines(), usingMock: true };
    }
    return { tontines, usingMock: false };
  } catch (error) {
    if (error instanceof ApiError) {
      return { tontines: buildMockTontines(), usingMock: true };
    }
    throw error;
  }
}

export async function listPublicTontines(
  token: string | null,
): Promise<{ tontines: TontineListItem[]; usingMock: boolean }> {
  try {
    const data = await apiFetch<{ tontines?: unknown[] }>("/tontines/public?limit=20", token);
    const tontines = mapTontineList(data.tontines ?? []);
    if (tontines.length === 0) {
      return { tontines: buildMockTontines(), usingMock: true };
    }
    return { tontines, usingMock: false };
  } catch (error) {
    if (error instanceof ApiError) {
      return { tontines: buildMockTontines(), usingMock: true };
    }
    throw error;
  }
}

export async function getTontineOverview(
  token: string | null,
  tontineId: string,
): Promise<{ tontine: TontineOverview; usingMock: boolean }> {
  try {
    const detailPromise = apiFetch<Record<string, unknown>>(`/tontines/${encodeURIComponent(tontineId)}`, token);
    const schedulePromise = apiFetch<{ schedule?: Record<string, unknown>[] }>(
      `/community/tontines/${encodeURIComponent(tontineId)}/schedule`,
      token,
    ).catch(() => ({ schedule: [] }));

    const [detail, schedule] = await Promise.all([detailPromise, schedulePromise]);
    const currentRound = asNumber(detail.currentRound, 0);
    const membersRaw = (detail.members as Record<string, unknown>[] | undefined) ?? [];
    const members = membersRaw.map((row) => reliabilityFromMember(row, currentRound));
    const timeline = makeTimelineFromSchedule(schedule.schedule, currentRound);
    const history = timeline.filter((row) => row.status === "done");
    const nextReceiver =
      members.find((member) => member.payoutOrder === currentRound + 1) ??
      members.find((member) => !member.hasReceivedPayout);

    const overview: TontineOverview = {
      id: asString(detail.id, tontineId),
      name: asString(detail.name, "Tontine"),
      status: (asString(detail.status, "pending") as TontineOverview["status"]) ?? "pending",
      frequency: (asString(detail.frequency, "monthly") as TontineFrequency) ?? "monthly",
      tontineType: asString(detail.tontineType, "classic"),
      contributionAmount: asNumber(detail.contributionAmount),
      currentRound,
      totalRounds: asNumber(detail.totalRounds, asNumber(detail.maxMembers, 1)),
      memberCount: asNumber(detail.memberCount, members.length),
      maxMembers: asNumber(detail.maxMembers, members.length),
      nextReceiver,
      nextPayoutDate: detail.nextPayoutDate ? asString(detail.nextPayoutDate) : null,
      members,
      timeline,
      history,
      notifications: [
        `${members.filter((member) => member.paymentStatus === "late").length} membre(s) en retard`,
        nextReceiver
          ? `Prochaine personne a recevoir: ${nextReceiver.userName}`
          : "Prochaine personne a recevoir: a definir",
      ],
    };

    if (overview.members.length === 0) {
      return { tontine: buildMockOverview(tontineId), usingMock: true };
    }

    return { tontine: overview, usingMock: false };
  } catch (error) {
    if (error instanceof ApiError) {
      return { tontine: buildMockOverview(tontineId), usingMock: true };
    }
    throw error;
  }
}

export async function joinTontine(
  token: string | null,
  tontineId: string,
  userId: string,
): Promise<void> {
  try {
    await apiFetch(
      `/community/tontines/${encodeURIComponent(tontineId)}/members`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ userId }),
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      return;
    }
    if (error instanceof ApiError && error.status === 400) {
      return;
    }
    throw error;
  }
}

export async function createTontine(
  token: string | null,
  userId: string,
  input: CreateTontineInput,
): Promise<{ tontineId: string; usingMock: boolean }> {
  try {
    const created = await apiFetch<Record<string, unknown>>("/tontines", token, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        description: input.description ?? null,
        contributionAmount: input.contributionAmount,
        currency: "XOF",
        frequency: input.frequency,
        maxMembers: input.maxMembers,
        adminUserId: userId,
        tontine_type: input.tontineType,
        is_public: true,
      }),
    });

    const tontineId = asString(created.id, `mock-${Date.now()}`);

    await apiFetch(`/community/tontines/${encodeURIComponent(tontineId)}/activate`, token, {
      method: "POST",
      body: JSON.stringify({ rotationModel: "fixed" }),
    }).catch(() => undefined);

    return { tontineId, usingMock: false };
  } catch (error) {
    if (error instanceof ApiError) {
      return { tontineId: `mock-${Date.now()}`, usingMock: true };
    }
    throw error;
  }
}

export async function collectContribution(
  token: string | null,
  tontineId: string,
): Promise<void> {
  await apiFetch(`/community/tontines/${encodeURIComponent(tontineId)}/collect`, token, {
    method: "POST",
    headers: { "Idempotency-Key": generateIdempotencyKey() },
  });
}

