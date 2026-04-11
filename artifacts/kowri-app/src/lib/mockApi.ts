const STORAGE_KEY = "kowri_demo_mock_state_v1";
const DEMO_USER_ID = "demo-user";
const DAY_MS = 86_400_000;

type AnyRecord = Record<string, any>;

export class MockApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "MockApiError";
  }
}

export function isDemoToken(token: string | null): boolean {
  return typeof token === "string" && token.startsWith("demo-token-");
}

interface DemoState {
  users: Record<string, AnyRecord>;
  wallets: AnyRecord[];
  transactions: AnyRecord[];
  notifications: AnyRecord[];
  supportTickets: AnyRecord[];
  kycByUser: Record<string, AnyRecord | null>;
  tontines: AnyRecord[];
  tontineMembers: Record<string, AnyRecord[]>;
  tontineGoals: Record<string, AnyRecord[]>;
  tontineBids: Record<string, AnyRecord[]>;
  tontineListings: AnyRecord[];
  tontineHybrid: Record<string, AnyRecord>;
  savingsPlans: AnyRecord[];
  creditScores: Record<string, AnyRecord>;
  loans: AnyRecord[];
  diasporaCorridors: AnyRecord[];
  diasporaBeneficiaries: AnyRecord[];
  diasporaRecurring: AnyRecord[];
  merchants: AnyRecord[];
  creatorCommunities: AnyRecord[];
  investmentPools: AnyRecord[];
  insurancePools: AnyRecord[];
  insurancePolicies: Record<string, AnyRecord[]>;
  insuranceClaims: Record<string, AnyRecord[]>;
  agents: AnyRecord[];
  agentLiquidity: Record<string, AnyRecord>;
  agentCommissions: Record<string, AnyRecord>;
  reputations: Record<string, AnyRecord>;
  reputationBadges: Record<string, AnyRecord[]>;
  seq: Record<string, number>;
}

let memoizedState: DemoState | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function dayOffset(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function minuteOffset(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function asNumber(value: any, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function parseBody(body: BodyInit | null | undefined): AnyRecord {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return {};
}

function sortByDateDesc(items: AnyRecord[]): AnyRecord[] {
  return [...items].sort((a, b) => {
    const at = new Date(a.createdAt ?? a.updatedAt ?? 0).getTime();
    const bt = new Date(b.createdAt ?? b.updatedAt ?? 0).getTime();
    return bt - at;
  });
}

function withPagination(items: AnyRecord[], limitRaw: string | null, pageRaw: string | null): AnyRecord[] {
  const limit = Math.max(1, asNumber(limitRaw, 20));
  const page = Math.max(1, asNumber(pageRaw, 1));
  const start = (page - 1) * limit;
  return items.slice(start, start + limit);
}

function pushNotification(state: DemoState, payload: AnyRecord): void {
  const id = nextId(state, "notif");
  state.notifications.unshift({
    id,
    userId: DEMO_USER_ID,
    type: payload.type ?? "info",
    title: payload.title ?? "Information",
    message: payload.message ?? "",
    channel: "in_app",
    read: false,
    metadata: payload.metadata ?? null,
    createdAt: nowIso(),
  });
}

function pushTransaction(state: DemoState, payload: AnyRecord): AnyRecord {
  const tx = {
    id: nextId(state, "tx"),
    type: payload.type ?? "send",
    amount: asNumber(payload.amount, 0),
    description: payload.description ?? "Transaction",
    fromWalletId: payload.fromWalletId ?? null,
    toWalletId: payload.toWalletId ?? null,
    walletId: payload.walletId ?? null,
    direction: payload.direction ?? null,
    createdAt: nowIso(),
  };
  state.transactions.unshift(tx);
  return tx;
}

function nextId(state: DemoState, prefix: string): string {
  const current = state.seq[prefix] ?? 1;
  state.seq[prefix] = current + 1;
  return `${prefix}-${current.toString().padStart(4, "0")}`;
}

function getWalletById(state: DemoState, walletId: string): AnyRecord {
  const wallet = state.wallets.find((w) => w.id === walletId);
  if (!wallet) throw new MockApiError(404, "Wallet introuvable");
  return wallet;
}

function getUserWallet(state: DemoState, userId: string): AnyRecord {
  const wallet = state.wallets.find((w) => w.userId === userId && String(w.id).startsWith("wallet-"));
  if (!wallet) throw new MockApiError(404, "Wallet utilisateur introuvable");
  return wallet;
}

function ensureMemberCount(state: DemoState, tontine: AnyRecord): AnyRecord {
  const members = state.tontineMembers[tontine.id] ?? [];
  return {
    ...tontine,
    memberCount: members.length,
    maxMembers: tontine.maxMembers ?? tontine.totalRounds ?? members.length,
    totalRounds: tontine.totalRounds ?? tontine.maxMembers ?? members.length,
    type: tontine.type ?? tontine.tontineType ?? "classic",
    tontineType: tontine.tontineType ?? tontine.type ?? "classic",
    nextPayoutAt: tontine.nextPayoutAt ?? tontine.nextPayoutDate ?? dayOffset(7),
    nextPayoutDate: tontine.nextPayoutDate ?? tontine.nextPayoutAt ?? dayOffset(7),
  };
}

function savingsSnapshot(plan: AnyRecord): AnyRecord {
  const createdAt = new Date(plan.createdAt).getTime();
  const maturityDate = new Date(plan.maturityDate).getTime();
  const now = Date.now();
  const totalDays = Math.max(1, Math.round((maturityDate - createdAt) / DAY_MS));
  const elapsedDays = Math.max(0, Math.round((now - createdAt) / DAY_MS));
  const daysRemaining = Math.max(0, totalDays - elapsedDays);
  const isMatured = daysRemaining <= 0;
  const lockedAmount = asNumber(plan.lockedAmount, 0);
  const interestRate = asNumber(plan.interestRate, 8);
  const accruedYield = (lockedAmount * interestRate * Math.min(elapsedDays, totalDays)) / 36500;
  return {
    ...plan,
    daysRemaining,
    isMatured,
    accruedYield,
    status: plan.status === "broken" ? "broken" : isMatured ? "matured" : "active",
  };
}

function createInitialState(): DemoState {
  const demoWallet = {
    id: "wallet-demo-1",
    userId: DEMO_USER_ID,
    balance: 780_000,
    availableBalance: 780_000,
    currency: "XOF",
    status: "active",
    createdAt: dayOffset(-120),
    updatedAt: nowIso(),
  };

  const tontineOneId = "tontine-0001";
  const tontineTwoId = "tontine-0002";
  const tontineThreeId = "tontine-0003";

  const communities = [
    {
      id: "community-0001",
      name: "Createurs Abidjan",
      handle: "createurs_abj",
      description: "Communauté d'entraide et d'investissement local.",
      creatorId: DEMO_USER_ID,
      creatorFeeRate: 0.05,
      platformFeeRate: 0.02,
      memberIds: [DEMO_USER_ID, "usr-anna", "usr-moussa"],
      totalEarnings: 82_000,
      createdAt: dayOffset(-45),
    },
    {
      id: "community-0002",
      name: "Invest Dakar",
      handle: "invest_dkr",
      description: "Tontines orientées investissement commerce.",
      creatorId: "usr-amy",
      creatorFeeRate: 0.06,
      platformFeeRate: 0.02,
      memberIds: ["usr-amy", "usr-aicha"],
      totalEarnings: 45_000,
      createdAt: dayOffset(-30),
    },
  ];

  const investmentPools = [
    {
      id: "pool-invest-0001",
      name: "Pool Commerce Local",
      status: "open",
      expectedReturn: 14,
      goalAmount: 2_000_000,
      currentAmount: 920_000,
      minInvestment: 15_000,
      nav: 1.08,
      managerId: DEMO_USER_ID,
      managerName: "Compte Demo",
      description: "Financement de micro-commerces locaux.",
      communityId: "community-0001",
      positions: [
        {
          id: "pos-0001",
          userId: DEMO_USER_ID,
          userName: "Compte Demo",
          investedAmount: 120_000,
          shares: 111_111,
          joinedAt: dayOffset(-25),
        },
      ],
    },
    {
      id: "pool-invest-0002",
      name: "Pool Agro Plus",
      status: "active",
      expectedReturn: 11,
      goalAmount: 1_500_000,
      currentAmount: 1_250_000,
      minInvestment: 25_000,
      nav: 1.12,
      managerId: "usr-amy",
      managerName: "Amy Kane",
      description: "Développement de l'agro-transformation.",
      communityId: "community-0002",
      positions: [],
    },
    {
      id: "pool-invest-0003",
      name: "Pool Energie Solidaire",
      status: "completed",
      expectedReturn: 9,
      goalAmount: 1_000_000,
      currentAmount: 1_000_000,
      minInvestment: 10_000,
      nav: 1.04,
      managerId: "usr-binta",
      managerName: "Binta Traore",
      description: "Projet energie locale.",
      communityId: null,
      positions: [],
    },
  ];

  return {
    users: {
      [DEMO_USER_ID]: {
        id: DEMO_USER_ID,
        phone: "+2250700000000",
        firstName: "Compte",
        lastName: "Demo",
        status: "active",
        country: "CI",
        avatarUrl: null,
        kycLevel: 1,
        pin: "1234",
      },
    },
    wallets: [
      demoWallet,
    ],
    transactions: [
      {
        id: "tx-0001",
        type: "receive",
        amount: 350_000,
        description: "Encaissement client",
        fromWalletId: "external",
        toWalletId: demoWallet.id,
        direction: "in",
        createdAt: dayOffset(-12),
      },
      {
        id: "tx-0002",
        type: "send",
        amount: 25_000,
        description: "Transfert P2P",
        fromWalletId: demoWallet.id,
        toWalletId: "wallet-friend-01",
        direction: "out",
        createdAt: dayOffset(-6),
      },
      {
        id: "tx-0003",
        type: "tontine",
        amount: 20_000,
        description: "Cotisation tontine",
        fromWalletId: demoWallet.id,
        toWalletId: "pot-0001",
        direction: "out",
        createdAt: dayOffset(-4),
      },
      {
        id: "tx-0004",
        type: "credit",
        amount: 150_000,
        description: "Décaissement crédit KOWRI",
        fromWalletId: "credit-engine",
        toWalletId: demoWallet.id,
        direction: "in",
        createdAt: dayOffset(-3),
      },
      {
        id: "tx-0005",
        type: "send",
        amount: 12_500,
        description: "Paiement service",
        fromWalletId: demoWallet.id,
        toWalletId: "merchant-demo-1",
        direction: "out",
        createdAt: dayOffset(-2),
      },
      {
        id: "tx-0006",
        type: "receive",
        amount: 18_000,
        description: "Remboursement ami",
        fromWalletId: "wallet-friend-02",
        toWalletId: demoWallet.id,
        direction: "in",
        createdAt: dayOffset(-1),
      },
    ],
    notifications: [
      {
        id: "notif-0001",
        userId: DEMO_USER_ID,
        type: "transaction",
        title: "Paiement reçu",
        message: "Vous avez reçu 18 000 XOF.",
        channel: "in_app",
        read: false,
        metadata: null,
        createdAt: minuteOffset(-10),
      },
      {
        id: "notif-0002",
        userId: DEMO_USER_ID,
        type: "tontine",
        title: "Tour de cotisation",
        message: "Votre cotisation de cette semaine est attendue.",
        channel: "in_app",
        read: false,
        metadata: null,
        createdAt: minuteOffset(-90),
      },
      {
        id: "notif-0003",
        userId: DEMO_USER_ID,
        type: "credit",
        title: "Rappel crédit",
        message: "Prochaine échéance dans 7 jours.",
        channel: "in_app",
        read: true,
        metadata: null,
        createdAt: dayOffset(-1),
      },
    ],
    supportTickets: [
      {
        id: "ticket-0001",
        ticketNumber: "TKT-1001",
        userId: DEMO_USER_ID,
        category: "TRANSACTION_ISSUE",
        title: "Retard de confirmation",
        description: "Une transaction a mis plus de temps que prévu.",
        status: "RESOLVED",
        resolution: "La transaction a été confirmée.",
        createdAt: dayOffset(-8),
      },
      {
        id: "ticket-0002",
        ticketNumber: "TKT-1002",
        userId: DEMO_USER_ID,
        category: "APP_BUG",
        title: "Affichage lent sur mobile",
        description: "Le chargement est lent sur certains onglets.",
        status: "IN_PROGRESS",
        resolution: null,
        createdAt: dayOffset(-2),
      },
    ],
    kycByUser: {
      [DEMO_USER_ID]: {
        id: "kyc-0001",
        userId: DEMO_USER_ID,
        kycLevel: 1,
        status: "verified",
        submittedAt: dayOffset(-40),
        rejectionReason: null,
      },
    },
    tontines: [
      {
        id: tontineOneId,
        name: "Tontine Hybride Famille",
        tontineType: "hybrid",
        type: "hybrid",
        status: "active",
        contributionAmount: 25_000,
        frequency: "weekly",
        maxMembers: 8,
        totalRounds: 8,
        currentRound: 3,
        nextPayoutDate: dayOffset(5),
        nextPayoutAt: dayOffset(5),
        adminUserId: DEMO_USER_ID,
        isPublic: true,
        strategyMode: true,
        yieldRate: 6,
      },
      {
        id: tontineTwoId,
        name: "Tontine Classique Quartier",
        tontineType: "classic",
        type: "classic",
        status: "active",
        contributionAmount: 15_000,
        frequency: "monthly",
        maxMembers: 6,
        totalRounds: 6,
        currentRound: 2,
        nextPayoutDate: dayOffset(12),
        nextPayoutAt: dayOffset(12),
        adminUserId: "usr-aicha",
        isPublic: true,
        strategyMode: false,
      },
      {
        id: tontineThreeId,
        name: "Projet Boutique Communautaire",
        tontineType: "project",
        type: "project",
        status: "pending",
        contributionAmount: 20_000,
        frequency: "monthly",
        maxMembers: 10,
        totalRounds: 10,
        currentRound: 1,
        nextPayoutDate: dayOffset(20),
        nextPayoutAt: dayOffset(20),
        adminUserId: DEMO_USER_ID,
        isPublic: true,
        strategyMode: false,
      },
    ],
    tontineMembers: {
      [tontineOneId]: [
        { id: "tm-0001", userId: DEMO_USER_ID, payoutOrder: 3, hasReceivedPayout: 0, contributionsCount: 2, user: { firstName: "Compte", lastName: "Demo", phone: "+2250700000000" } },
        { id: "tm-0002", userId: "usr-anna", payoutOrder: 1, hasReceivedPayout: 1, contributionsCount: 3, user: { firstName: "Anna", lastName: "Konan", phone: "+2250101010101" } },
        { id: "tm-0003", userId: "usr-moussa", payoutOrder: 2, hasReceivedPayout: 1, contributionsCount: 3, user: { firstName: "Moussa", lastName: "Diabate", phone: "+2250202020202" } },
      ],
      [tontineTwoId]: [
        { id: "tm-0004", userId: DEMO_USER_ID, payoutOrder: 2, hasReceivedPayout: 0, contributionsCount: 1, user: { firstName: "Compte", lastName: "Demo", phone: "+2250700000000" } },
        { id: "tm-0005", userId: "usr-aicha", payoutOrder: 1, hasReceivedPayout: 1, contributionsCount: 2, user: { firstName: "Aicha", lastName: "Sow", phone: "+221770000000" } },
      ],
      [tontineThreeId]: [
        { id: "tm-0006", userId: DEMO_USER_ID, payoutOrder: 1, hasReceivedPayout: 0, contributionsCount: 0, user: { firstName: "Compte", lastName: "Demo", phone: "+2250700000000" } },
      ],
    },
    tontineGoals: {
      [tontineThreeId]: [
        {
          id: "goal-0001",
          tontineId: tontineThreeId,
          goalDescription: "Achat d'equipements",
          vendorName: "Fournisseur CI",
          goalAmount: 500_000,
          currentAmount: 320_000,
          status: "open",
        },
      ],
    },
    tontineBids: {
      [tontineOneId]: [
        {
          id: "bid-0001",
          tontineId: tontineOneId,
          userId: "usr-anna",
          bidAmount: 35_000,
          desiredPosition: 1,
          createdAt: dayOffset(-1),
        },
      ],
    },
    tontineListings: [
      {
        id: "listing-0001",
        tontineId: tontineOneId,
        tontineName: "Tontine Hybride Famille",
        payoutOrder: 5,
        askPrice: 40_000,
        sellerId: "usr-moussa",
        createdAt: dayOffset(-1),
      },
    ],
    tontineHybrid: {
      [tontineOneId]: {
        hybridConfig: {
          rotation_pct: 60,
          investment_pct: 20,
          solidarity_pct: 10,
          yield_pct: 10,
        },
        solidarityReserveBalance: 34_500,
      },
    },
    savingsPlans: [
      {
        id: "save-0001",
        userId: DEMO_USER_ID,
        walletId: demoWallet.id,
        name: "Epargne Voyage",
        lockedAmount: 120_000,
        interestRate: 8,
        termDays: 90,
        status: "active",
        createdAt: dayOffset(-20),
        maturityDate: dayOffset(70),
      },
      {
        id: "save-0002",
        userId: DEMO_USER_ID,
        walletId: demoWallet.id,
        name: "Fonds Urgence",
        lockedAmount: 80_000,
        interestRate: 7.5,
        termDays: 60,
        status: "active",
        createdAt: dayOffset(-70),
        maturityDate: dayOffset(-10),
      },
    ],
    creditScores: {
      [DEMO_USER_ID]: {
        userId: DEMO_USER_ID,
        score: 63,
        tier: "silver",
        maxLoanAmount: 350_000,
        interestRate: 12,
        factors: {
          transactionVolume: 0.74,
          tontineParticipation: 0.62,
          paymentHistory: 0.71,
          networkScore: 0.55,
          savingsRegularity: 0.58,
        },
      },
    },
    loans: [
      {
        id: "loan-0001",
        userId: DEMO_USER_ID,
        walletId: demoWallet.id,
        amount: 150_000,
        amountRepaid: 45_000,
        interestRate: 12,
        termDays: 60,
        dueDate: dayOffset(20),
        status: "disbursed",
        createdAt: dayOffset(-8),
      },
    ],
    diasporaCorridors: [
      { id: "cor-0001", fromCurrency: "XOF", toCurrency: "GHS", fromCountry: "CI", toCountry: "GH", estimatedMins: 5, flatFee: 250, percentFee: 0.01 },
      { id: "cor-0002", fromCurrency: "XOF", toCurrency: "NGN", fromCountry: "CI", toCountry: "NG", estimatedMins: 8, flatFee: 400, percentFee: 0.012 },
      { id: "cor-0003", fromCurrency: "XOF", toCurrency: "EUR", fromCountry: "CI", toCountry: "FR", estimatedMins: 15, flatFee: 800, percentFee: 0.018 },
    ],
    diasporaBeneficiaries: [
      { id: "bene-0001", userId: DEMO_USER_ID, name: "Mariam Cisse", country: "SN", phone: "+221771112233", currency: "XOF", relationship: "family" },
      { id: "bene-0002", userId: DEMO_USER_ID, name: "Kwame N.", country: "GH", phone: "+233540000000", currency: "GHS", relationship: "friend" },
    ],
    diasporaRecurring: [
      {
        id: "recur-0001",
        userId: DEMO_USER_ID,
        beneficiaryId: "bene-0001",
        amount: 20_000,
        currency: "XOF",
        frequency: "monthly",
        status: "active",
        nextRunAt: dayOffset(10),
        createdAt: dayOffset(-15),
      },
    ],
    merchants: [],
    creatorCommunities: communities,
    investmentPools,
    insurancePools: [
      {
        id: "ins-0001",
        name: "Sante Famille",
        insuranceType: "health",
        premiumAmount: 7_500,
        claimLimit: 400_000,
        memberCount: 12,
        maxMembers: 100,
        reserveRatio: 0.35,
        status: "active",
      },
      {
        id: "ins-0002",
        name: "Protection Commerce",
        insuranceType: "property",
        premiumAmount: 9_000,
        claimLimit: 600_000,
        memberCount: 8,
        maxMembers: 80,
        reserveRatio: 0.42,
        status: "active",
      },
    ],
    insurancePolicies: {
      "ins-0001": [
        {
          id: "pol-0001",
          poolId: "ins-0001",
          userId: DEMO_USER_ID,
          status: "active",
          nextPaymentDate: dayOffset(18),
          createdAt: dayOffset(-40),
        },
      ],
      "ins-0002": [],
    },
    insuranceClaims: {
      "ins-0001": [
        {
          id: "claim-0001",
          poolId: "ins-0001",
          userId: DEMO_USER_ID,
          policyId: "pol-0001",
          claimAmount: 55_000,
          reason: "Consultation et medicaments",
          status: "under_review",
          createdAt: dayOffset(-5),
        },
      ],
      "ins-0002": [],
    },
    agents: [
      {
        id: "agent-0001",
        userId: DEMO_USER_ID,
        name: "Agent Demo Abobo",
        type: "AGENT",
        zone: "Abobo",
        status: "ACTIVE",
        commissionTier: 2,
        monthlyVolume: "6200000",
      },
    ],
    agentLiquidity: {
      "agent-0001": {
        cashBalance: 210_000,
        floatBalance: 490_000,
        minCashThreshold: 150_000,
        minFloatThreshold: 250_000,
        monthlyVolume: 6_200_000,
        commissionTier: 2,
        activeAlerts: [
          {
            id: "alert-0001",
            type: "CASH_WARNING",
            level: "WARNING",
            message: "Le cash approche le seuil minimum.",
            suggestedAction: "Prévoir un réapprovisionnement avant ce soir.",
            createdAt: dayOffset(-1),
          },
        ],
        suggestions: [
          "Maintenir le float au-dessus de 300 000 XOF.",
          "Augmenter les encaissements marchands en heure de pointe.",
        ],
        nearestSuperAgent: {
          id: "super-0001",
          name: "Super Agent Plateau",
          floatBalance: 2_300_000,
        },
      },
    },
    agentCommissions: {
      "agent-0001": {
        totals: {
          earnedThisMonth: 84_500,
          pending: 11_200,
          paid: 230_000,
          today: 4_200,
        },
      },
    },
    reputations: {
      [DEMO_USER_ID]: {
        userId: DEMO_USER_ID,
        score: 58,
        tier: "SILVER",
        factors: {
          transactionVolume: 0.67,
          tontineParticipation: 0.6,
          paymentHistory: 0.7,
          networkScore: 0.52,
          savingsRegularity: 0.5,
        },
      },
    },
    reputationBadges: {
      [DEMO_USER_ID]: [
        { id: "badge-0001", badge: "FIRST_TONTINE", label: "Première tontine" },
        { id: "badge-0002", badge: "RELIABLE_PAYER", label: "Payeur fiable" },
        { id: "badge-0003", badge: "COMMUNITY_BUILDER", label: "Bâtisseur communautaire" },
      ],
    },
    seq: {
      tx: 7,
      notif: 4,
      ticket: 1003,
      save: 3,
      loan: 2,
      bene: 3,
      recur: 2,
      merchant: 1,
      merchantwallet: 1,
      community: 3,
      goal: 2,
      policy: 2,
      claim: 2,
      bid: 2,
      listing: 2,
      member: 7,
      tontine: 4,
      avatar: 1,
    },
  };
}

function loadState(): DemoState {
  if (memoizedState) return memoizedState;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      memoizedState = JSON.parse(raw) as DemoState;
      return memoizedState;
    }
  } catch {
    // ignore broken storage and recreate
  }

  memoizedState = createInitialState();
  persistState(memoizedState);
  return memoizedState;
}

function persistState(state: DemoState): void {
  memoizedState = state;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage quota errors
  }
}

async function tinyDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function throwNotFound(pathname: string): never {
  throw new MockApiError(404, `Route démo introuvable: ${pathname}`);
}

export async function mockApiFetch<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
): Promise<T> {
  if (!isDemoToken(token)) {
    throw new MockApiError(401, "Session demo invalide");
  }

  await tinyDelay();

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(normalizedPath, "https://mock.kowri.local");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const query = url.searchParams;
  const method = (options.method ?? "GET").toUpperCase();
  const body = parseBody(options.body);

  const state = loadState();

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------
  if (pathname === "/notifications" && method === "GET") {
    const items = sortByDateDesc(
      state.notifications.filter((n) => n.userId === DEMO_USER_ID),
    );
    const unreadCount = items.filter((n) => !n.read).length;
    return clone({ notifications: items, unreadCount }) as T;
  }

  const notifReadMatch = pathname.match(/^\/notifications\/([^/]+)\/read$/);
  if (notifReadMatch && method === "PATCH") {
    const notification = state.notifications.find((n) => n.id === notifReadMatch[1] && n.userId === DEMO_USER_ID);
    if (!notification) throw new MockApiError(404, "Notification introuvable");
    notification.read = true;
    persistState(state);
    return clone({ success: true }) as T;
  }

  if (pathname === "/notifications/read-all" && method === "PATCH") {
    state.notifications.forEach((n) => {
      if (n.userId === DEMO_USER_ID) n.read = true;
    });
    persistState(state);
    return clone({ success: true }) as T;
  }

  // ---------------------------------------------------------------------------
  // Wallets
  // ---------------------------------------------------------------------------
  if (pathname === "/wallets" && method === "GET") {
    const userId = query.get("userId") ?? DEMO_USER_ID;
    const wallets = state.wallets.filter((w) => w.userId === userId);
    const limited = withPagination(wallets, query.get("limit"), query.get("page"));
    return clone({ wallets: limited }) as T;
  }

  const walletByIdMatch = pathname.match(/^\/wallets\/([^/]+)$/);
  if (walletByIdMatch && method === "GET") {
    const wallet = getWalletById(state, walletByIdMatch[1]);
    return clone(wallet) as T;
  }

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------
  if (pathname === "/transactions" && method === "GET") {
    const walletId = query.get("walletId");
    if (!walletId) throw new MockApiError(400, "walletId requis");

    let transactions = state.transactions.filter(
      (tx) => tx.fromWalletId === walletId || tx.toWalletId === walletId || tx.walletId === walletId,
    );

    const typeFilter = query.get("type");
    if (typeFilter && typeFilter !== "Tous") {
      transactions = transactions.filter((tx) => {
        if (typeFilter === "tontine") return String(tx.type).includes("tontine");
        return tx.type === typeFilter;
      });
    }

    transactions = sortByDateDesc(transactions);
    const limit = Math.max(1, asNumber(query.get("limit"), 20));
    const page = Math.max(1, asNumber(query.get("page"), 1));
    const start = (page - 1) * limit;
    const sliced = transactions.slice(start, start + limit);

    return clone({
      transactions: sliced,
      pagination: {
        total: transactions.length,
        page,
        limit,
      },
    }) as T;
  }

  if (pathname === "/transactions/transfer" && method === "POST") {
    const fromWallet = getWalletById(state, body.fromWalletId);
    const amount = asNumber(body.amount, 0);
    if (amount <= 0) throw new MockApiError(400, "Montant invalide");
    const fee = amount * 0.005;
    const total = amount + fee;
    if (fromWallet.availableBalance < total) {
      throw new MockApiError(400, "Solde insuffisant");
    }

    fromWallet.availableBalance -= total;
    fromWallet.balance -= total;
    fromWallet.updatedAt = nowIso();

    const tx = pushTransaction(state, {
      type: "send",
      amount,
      description: body.description ?? "Transfert P2P",
      fromWalletId: fromWallet.id,
      toWalletId: `phone:${body.recipientPhone ?? "unknown"}`,
      direction: "out",
    });

    pushNotification(state, {
      type: "transaction",
      title: "Transfert envoyé",
      message: `${amount.toLocaleString("fr-FR")} XOF envoyés.`,
      metadata: { transactionId: tx.id },
    });

    persistState(state);
    return clone({ id: tx.id, transactionId: tx.id }) as T;
  }

  // ---------------------------------------------------------------------------
  // Savings
  // ---------------------------------------------------------------------------
  if (pathname === "/savings/rate" && method === "GET") {
    return clone({ annualRate: 8.5 }) as T;
  }

  if (pathname === "/savings/plans" && method === "GET") {
    const userId = query.get("userId") ?? DEMO_USER_ID;
    const status = query.get("status");
    let plans = state.savingsPlans
      .filter((plan) => plan.userId === userId)
      .map((plan) => savingsSnapshot(plan));

    if (status) plans = plans.filter((plan) => plan.status === status);
    plans = sortByDateDesc(plans);
    return clone({ plans }) as T;
  }

  if (pathname === "/savings/plans" && method === "POST") {
    const wallet = getWalletById(state, body.walletId);
    const amount = asNumber(body.amount, 0);
    const termDays = Math.max(1, asNumber(body.termDays, 30));
    if (amount <= 0) throw new MockApiError(400, "Montant invalide");
    if (wallet.availableBalance < amount) throw new MockApiError(400, "Solde insuffisant");

    wallet.availableBalance -= amount;
    wallet.balance -= amount;
    wallet.updatedAt = nowIso();

    const plan = {
      id: nextId(state, "save"),
      userId: body.userId ?? DEMO_USER_ID,
      walletId: wallet.id,
      name: body.name ?? "Plan d'épargne",
      lockedAmount: amount,
      interestRate: 8,
      termDays,
      status: "active",
      createdAt: nowIso(),
      maturityDate: dayOffset(termDays),
    };

    state.savingsPlans.unshift(plan);

    pushTransaction(state, {
      type: "savings",
      amount,
      description: `Création plan "${plan.name}"`,
      fromWalletId: wallet.id,
      toWalletId: "savings-vault",
      direction: "out",
    });

    persistState(state);
    return clone(savingsSnapshot(plan)) as T;
  }

  const savingsBreakMatch = pathname.match(/^\/savings\/plans\/([^/]+)\/break$/);
  if (savingsBreakMatch && method === "POST") {
    const plan = state.savingsPlans.find((p) => p.id === savingsBreakMatch[1]);
    if (!plan) throw new MockApiError(404, "Plan introuvable");
    const snapshot = savingsSnapshot(plan);

    if (plan.status === "broken" || plan.status === "matured") {
      throw new MockApiError(400, "Plan déjà clôturé");
    }

    const targetWalletId = body.targetWalletId ?? plan.walletId;
    const wallet = getWalletById(state, targetWalletId);
    const earlyBreak = !!body.isBreak && !snapshot.isMatured;
    const payoutYield = earlyBreak ? snapshot.accruedYield * 0.9 : snapshot.accruedYield;
    const payoutAmount = snapshot.lockedAmount + payoutYield;

    wallet.availableBalance += payoutAmount;
    wallet.balance += payoutAmount;
    wallet.updatedAt = nowIso();

    plan.status = earlyBreak ? "broken" : "matured";
    plan.closedAt = nowIso();

    pushTransaction(state, {
      type: "receive",
      amount: payoutAmount,
      description: earlyBreak ? `Rupture anticipée ${plan.name}` : `Déblocage ${plan.name}`,
      fromWalletId: "savings-vault",
      toWalletId: wallet.id,
      direction: "in",
    });

    persistState(state);
    return clone({
      payoutAmount,
      status: plan.status,
      isFullyMatured: !earlyBreak,
    }) as T;
  }

  const savingsSummaryMatch = pathname.match(/^\/savings\/summary\/([^/]+)$/);
  if (savingsSummaryMatch && method === "GET") {
    const userId = savingsSummaryMatch[1];
    const plans = state.savingsPlans
      .filter((plan) => plan.userId === userId)
      .map((plan) => savingsSnapshot(plan));
    const activePlans = plans.filter((plan) => plan.status === "active").length;
    const totalLocked = plans.filter((plan) => plan.status === "active").reduce((sum, plan) => sum + asNumber(plan.lockedAmount, 0), 0);
    const totalYield = plans.reduce((sum, plan) => sum + asNumber(plan.accruedYield, 0), 0);
    return clone({
      activePlans,
      totalLocked,
      totalYield,
    }) as T;
  }

  // ---------------------------------------------------------------------------
  // Credit
  // ---------------------------------------------------------------------------
  const scoreComputeMatch = pathname.match(/^\/credit\/scores\/([^/]+)\/compute$/);
  if (scoreComputeMatch && method === "POST") {
    const userId = scoreComputeMatch[1];
    const current = state.creditScores[userId];
    if (!current) {
      state.creditScores[userId] = {
        userId,
        score: 45,
        tier: "bronze",
        maxLoanAmount: 150_000,
        interestRate: 14,
        factors: {
          transactionVolume: 0.55,
          tontineParticipation: 0.5,
          paymentHistory: 0.6,
          networkScore: 0.4,
          savingsRegularity: 0.45,
        },
      };
    } else {
      current.score = Math.min(100, asNumber(current.score, 45) + 2);
      current.maxLoanAmount = Math.max(150_000, Math.round(current.score * 6_000));
      current.interestRate = Math.max(9, 15 - Math.round(current.score / 15));
      current.tier = current.score >= 75 ? "gold" : current.score >= 55 ? "silver" : "bronze";
    }
    persistState(state);
    return clone(state.creditScores[userId]) as T;
  }

  const scoreGetMatch = pathname.match(/^\/credit\/scores\/([^/]+)$/);
  if (scoreGetMatch && method === "GET") {
    const score = state.creditScores[scoreGetMatch[1]];
    if (!score) throw new MockApiError(404, "Score indisponible");
    return clone(score) as T;
  }

  if (pathname === "/credit/loans" && method === "GET") {
    let loans = [...state.loans];
    const status = query.get("status");
    if (status) loans = loans.filter((loan) => loan.status === status);
    loans = sortByDateDesc(loans);
    const limit = Math.max(1, asNumber(query.get("limit"), 20));
    return clone({ loans: loans.slice(0, limit) }) as T;
  }

  if (pathname === "/credit/loans" && method === "POST") {
    const userId = body.userId ?? DEMO_USER_ID;
    const wallet = getWalletById(state, body.walletId);
    const amount = asNumber(body.amount, 0);
    const termDays = Math.max(1, asNumber(body.termDays, 30));
    const score = state.creditScores[userId];

    if (!score) throw new MockApiError(400, "Score de crédit requis");
    if (amount <= 0) throw new MockApiError(400, "Montant invalide");
    if (amount > asNumber(score.maxLoanAmount, 0)) {
      throw new MockApiError(400, "Montant supérieur au plafond autorisé");
    }

    const loan = {
      id: nextId(state, "loan"),
      userId,
      walletId: wallet.id,
      amount,
      amountRepaid: 0,
      interestRate: asNumber(score.interestRate, 12),
      termDays,
      dueDate: dayOffset(termDays),
      status: "disbursed",
      createdAt: nowIso(),
    };

    state.loans.unshift(loan);
    wallet.availableBalance += amount;
    wallet.balance += amount;

    pushTransaction(state, {
      type: "credit",
      amount,
      description: "Décaissement prêt",
      fromWalletId: "credit-engine",
      toWalletId: wallet.id,
      direction: "in",
    });

    pushNotification(state, {
      type: "credit",
      title: "Prêt accordé",
      message: `Votre prêt de ${amount.toLocaleString("fr-FR")} XOF est disponible.`,
    });

    persistState(state);
    return clone(loan) as T;
  }

  const repayMatch = pathname.match(/^\/credit\/loans\/([^/]+)\/repay$/);
  if (repayMatch && method === "POST") {
    const loan = state.loans.find((l) => l.id === repayMatch[1]);
    if (!loan) throw new MockApiError(404, "Prêt introuvable");
    const wallet = getWalletById(state, body.walletId);
    const amount = asNumber(body.amount, 0);
    if (amount <= 0) throw new MockApiError(400, "Montant invalide");
    if (wallet.availableBalance < amount) throw new MockApiError(400, "Solde insuffisant");

    const totalToRepay = asNumber(loan.amount, 0) * (1 + asNumber(loan.interestRate, 0) / 100);
    const remaining = Math.max(0, totalToRepay - asNumber(loan.amountRepaid, 0));
    const applied = Math.min(amount, remaining);

    wallet.availableBalance -= applied;
    wallet.balance -= applied;
    loan.amountRepaid = asNumber(loan.amountRepaid, 0) + applied;
    const isFullyRepaid = loan.amountRepaid >= totalToRepay - 0.01;
    if (isFullyRepaid) loan.status = "repaid";

    pushTransaction(state, {
      type: "credit",
      amount: applied,
      description: "Remboursement prêt",
      fromWalletId: wallet.id,
      toWalletId: "credit-engine",
      direction: "out",
    });

    persistState(state);
    return clone({
      isFullyRepaid,
      remainingAmount: Math.max(0, totalToRepay - loan.amountRepaid),
      appliedAmount: applied,
    }) as T;
  }

  // ---------------------------------------------------------------------------
  // Diaspora
  // ---------------------------------------------------------------------------
  if (pathname === "/diaspora/corridors" && method === "GET") {
    return clone({ corridors: state.diasporaCorridors }) as T;
  }

  if (pathname === "/diaspora/beneficiaries" && method === "GET") {
    const userId = query.get("userId") ?? DEMO_USER_ID;
    const beneficiaries = state.diasporaBeneficiaries.filter((b) => b.userId === userId);
    return clone({ beneficiaries }) as T;
  }

  if (pathname === "/diaspora/beneficiaries" && method === "POST") {
    const beneficiary = {
      id: nextId(state, "bene"),
      userId: body.userId ?? DEMO_USER_ID,
      name: body.name ?? "Nouveau bénéficiaire",
      country: body.country ?? "CI",
      phone: body.phone ?? "",
      walletId: body.walletId ?? null,
      currency: body.currency ?? "XOF",
      relationship: body.relationship ?? "other",
      createdAt: nowIso(),
    };
    state.diasporaBeneficiaries.unshift(beneficiary);
    persistState(state);
    return clone(beneficiary) as T;
  }

  if (pathname === "/diaspora/quote" && method === "POST") {
    const amount = asNumber(body.amount, 0);
    const fromCurrency = body.fromCurrency ?? "XOF";
    const toCurrency = body.toCurrency ?? "XOF";
    const corridor = state.diasporaCorridors.find((c) => c.fromCurrency === fromCurrency && c.toCurrency === toCurrency)
      ?? state.diasporaCorridors[0];
    const fee = asNumber(corridor.flatFee, 0) + amount * asNumber(corridor.percentFee, 0);
    return clone({
      bestQuote: {
        corridorId: corridor.id,
        fee,
        totalDebit: amount + fee,
        estimatedMins: corridor.estimatedMins ?? 10,
        toCurrency,
        sendAmount: amount,
      },
    }) as T;
  }

  if (pathname === "/diaspora/send" && method === "POST") {
    const wallet = getWalletById(state, body.fromWalletId);
    const amount = asNumber(body.amount, 0);
    if (amount <= 0) throw new MockApiError(400, "Montant invalide");
    const corridor = state.diasporaCorridors.find(
      (c) => c.fromCurrency === body.fromCurrency && c.toCurrency === body.toCurrency,
    );
    const fee = corridor ? asNumber(corridor.flatFee, 0) + amount * asNumber(corridor.percentFee, 0) : amount * 0.01;
    const total = amount + fee;
    if (wallet.availableBalance < total) throw new MockApiError(400, "Solde insuffisant");

    wallet.availableBalance -= total;
    wallet.balance -= total;

    const tx = pushTransaction(state, {
      type: "send",
      amount: total,
      description: body.description ?? "Transfert diaspora",
      fromWalletId: wallet.id,
      toWalletId: `diaspora:${body.beneficiaryId ?? "unknown"}`,
      direction: "out",
    });

    pushNotification(state, {
      type: "transaction",
      title: "Transfert diaspora",
      message: `${amount.toLocaleString("fr-FR")} ${body.fromCurrency ?? "XOF"} envoyés.`,
    });

    persistState(state);
    return clone({ id: tx.id, transactionId: tx.id }) as T;
  }

  if (pathname === "/diaspora/recurring" && method === "GET") {
    const userId = query.get("userId") ?? DEMO_USER_ID;
    const recurring = state.diasporaRecurring.filter((r) => r.userId === userId);
    return clone({ recurring: sortByDateDesc(recurring) }) as T;
  }

  if (pathname === "/diaspora/recurring" && method === "POST") {
    const recurring = {
      id: nextId(state, "recur"),
      userId: body.userId ?? DEMO_USER_ID,
      beneficiaryId: body.beneficiaryId,
      amount: asNumber(body.amount, 0),
      currency: body.currency ?? "XOF",
      frequency: body.frequency ?? "monthly",
      status: "active",
      nextRunAt: dayOffset(body.frequency === "weekly" ? 7 : body.frequency === "biweekly" ? 14 : 30),
      createdAt: nowIso(),
    };
    state.diasporaRecurring.unshift(recurring);
    persistState(state);
    return clone(recurring) as T;
  }

  const recurringActionMatch = pathname.match(/^\/diaspora\/recurring\/([^/]+)\/(pause|resume)$/);
  if (recurringActionMatch && method === "PATCH") {
    const recurring = state.diasporaRecurring.find((r) => r.id === recurringActionMatch[1]);
    if (!recurring) throw new MockApiError(404, "Virement introuvable");
    recurring.status = recurringActionMatch[2] === "pause" ? "paused" : "active";
    persistState(state);
    return clone(recurring) as T;
  }

  // ---------------------------------------------------------------------------
  // Merchants
  // ---------------------------------------------------------------------------
  if (pathname === "/merchants" && method === "GET") {
    const merchants = state.merchants.map((merchant) => {
      const payments = state.transactions.filter((tx) => tx.toWalletId === merchant.walletId);
      return {
        ...merchant,
        totalRevenue: payments.reduce((sum, tx) => sum + asNumber(tx.amount, 0), 0),
        transactionCount: payments.length,
      };
    });
    return clone({ merchants }) as T;
  }

  if (pathname === "/merchants" && method === "POST") {
    const existing = state.merchants.find((m) => m.userId === body.userId);
    if (existing) return clone(existing) as T;

    const merchantWallet = {
      id: `merchant-wallet-${nextId(state, "merchantwallet")}`,
      userId: body.userId,
      balance: 0,
      availableBalance: 0,
      currency: "XOF",
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.wallets.push(merchantWallet);

    const merchant = {
      id: nextId(state, "merchant"),
      userId: body.userId ?? DEMO_USER_ID,
      businessName: body.businessName ?? "Nouveau Marchand",
      businessType: body.businessType ?? "retail",
      country: body.country ?? "CI",
      status: "active",
      walletId: merchantWallet.id,
      totalRevenue: 0,
      transactionCount: 0,
      createdAt: nowIso(),
    };
    state.merchants.push(merchant);
    persistState(state);
    return clone(merchant) as T;
  }

  // ---------------------------------------------------------------------------
  // Support
  // ---------------------------------------------------------------------------
  if (pathname === "/support/tickets" && method === "GET") {
    const userId = query.get("userId") ?? DEMO_USER_ID;
    const tickets = sortByDateDesc(state.supportTickets.filter((t) => t.userId === userId));
    const limit = asNumber(query.get("limit"), tickets.length || 20);
    return clone({ tickets: tickets.slice(0, limit) }) as T;
  }

  if (pathname === "/support/tickets" && method === "POST") {
    const seq = state.seq.ticket ?? 1000;
    state.seq.ticket = seq + 1;
    const ticketNumber = `TKT-${seq}`;
    const ticket = {
      id: nextId(state, "ticket"),
      ticketNumber,
      userId: body.userId ?? DEMO_USER_ID,
      category: body.category ?? "OTHER",
      title: body.title ?? "Ticket support",
      description: body.description ?? "",
      status: "OPEN",
      resolution: null,
      createdAt: nowIso(),
    };
    state.supportTickets.unshift(ticket);
    pushNotification(state, {
      type: "info",
      title: "Ticket créé",
      message: `Votre ticket ${ticketNumber} a été enregistré.`,
      metadata: { ticketId: ticket.id },
    });
    persistState(state);
    return clone({ ticket, ticketNumber }) as T;
  }

  // ---------------------------------------------------------------------------
  // User + KYC + Profile security
  // ---------------------------------------------------------------------------
  if (pathname === "/users/me" && method === "GET") {
    return clone({ user: state.users[DEMO_USER_ID] }) as T;
  }

  const userKycMatch = pathname.match(/^\/users\/([^/]+)\/kyc$/);
  if (userKycMatch && method === "GET") {
    const userId = userKycMatch[1];
    return clone({ record: state.kycByUser[userId] ?? null }) as T;
  }

  if (userKycMatch && method === "POST") {
    const userId = userKycMatch[1];
    const record = {
      id: nextId(state, "kyc"),
      userId,
      kycLevel: asNumber(body.kycLevel, 1),
      status: "pending",
      submittedAt: nowIso(),
      rejectionReason: null,
      documentType: body.documentType ?? "national_id",
    };
    state.kycByUser[userId] = record;
    persistState(state);
    return clone({ record }) as T;
  }

  const userAvatarMatch = pathname.match(/^\/users\/([^/]+)\/avatar$/);
  if (userAvatarMatch && method === "PATCH") {
    const user = state.users[userAvatarMatch[1]];
    if (!user) throw new MockApiError(404, "Utilisateur introuvable");
    user.avatarUrl = body.avatarBase64 ?? null;
    persistState(state);
    return clone({ success: true, avatarUrl: user.avatarUrl }) as T;
  }

  const userPinMatch = pathname.match(/^\/users\/([^/]+)\/pin$/);
  if (userPinMatch && method === "PATCH") {
    const user = state.users[userPinMatch[1]];
    if (!user) throw new MockApiError(404, "Utilisateur introuvable");
    const oldPin = String(body.oldPin ?? "");
    const newPin = String(body.newPin ?? "");
    if (oldPin !== String(user.pin ?? "1234")) {
      throw new MockApiError(400, "PIN actuel incorrect");
    }
    if (!/^\d{4}$/.test(newPin)) throw new MockApiError(400, "Nouveau PIN invalide");
    user.pin = newPin;
    persistState(state);
    return clone({ success: true }) as T;
  }

  const userMatch = pathname.match(/^\/users\/([^/]+)$/);
  if (userMatch && method === "GET") {
    const user = state.users[userMatch[1]];
    if (!user) throw new MockApiError(404, "Utilisateur introuvable");
    return clone(user) as T;
  }

  // ---------------------------------------------------------------------------
  // Reputation
  // ---------------------------------------------------------------------------
  const badgesMatch = pathname.match(/^\/community\/reputation\/([^/]+)\/badges$/);
  if (badgesMatch && method === "GET") {
    return clone({ badges: state.reputationBadges[badgesMatch[1]] ?? [] }) as T;
  }

  const reputationComputeMatch = pathname.match(/^\/community\/reputation\/([^/]+)\/compute$/);
  if (reputationComputeMatch && method === "POST") {
    const userId = reputationComputeMatch[1];
    const current = state.reputations[userId] ?? {
      userId,
      score: 40,
      tier: "BRONZE",
      factors: {
        transactionVolume: 0.5,
        tontineParticipation: 0.5,
        paymentHistory: 0.5,
        networkScore: 0.5,
        savingsRegularity: 0.5,
      },
    };
    current.score = Math.min(100, asNumber(current.score, 40) + 1);
    current.tier = current.score >= 80 ? "PLATINUM" : current.score >= 60 ? "GOLD" : current.score >= 40 ? "SILVER" : "BRONZE";
    state.reputations[userId] = current;
    persistState(state);
    return clone(current) as T;
  }

  const reputationMatch = pathname.match(/^\/community\/reputation\/([^/]+)$/);
  if (reputationMatch && method === "GET") {
    const rep = state.reputations[reputationMatch[1]];
    if (!rep) throw new MockApiError(404, "Réputation indisponible");
    return clone(rep) as T;
  }

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------
  if (pathname === "/agents" && method === "GET") {
    const userId = query.get("userId") ?? DEMO_USER_ID;
    const limit = Math.max(1, asNumber(query.get("limit"), 20));
    const agents = state.agents.filter((a) => a.userId === userId).slice(0, limit);
    return clone({ agents }) as T;
  }

  const agentLiquidityMatch = pathname.match(/^\/agents\/([^/]+)\/liquidity$/);
  if (agentLiquidityMatch && method === "GET") {
    const data = state.agentLiquidity[agentLiquidityMatch[1]];
    if (!data) throw new MockApiError(404, "Données agent indisponibles");

    const cashStatus = data.cashBalance < data.minCashThreshold
      ? "CRITICAL"
      : data.cashBalance < data.minCashThreshold * 1.25
        ? "WARNING"
        : "OK";
    const floatStatus = data.floatBalance < data.minFloatThreshold
      ? "CRITICAL"
      : data.floatBalance < data.minFloatThreshold * 1.2
        ? "WARNING"
        : "OK";

    return clone({
      ...data,
      cashStatus,
      floatStatus,
    }) as T;
  }

  const agentCommissionsMatch = pathname.match(/^\/agents\/([^/]+)\/commissions$/);
  if (agentCommissionsMatch && method === "GET") {
    const data = state.agentCommissions[agentCommissionsMatch[1]];
    if (!data) throw new MockApiError(404, "Commissions indisponibles");
    return clone(data) as T;
  }

  const cashUpdateMatch = pathname.match(/^\/agents\/([^/]+)\/cash-update$/);
  if (cashUpdateMatch && method === "POST") {
    const data = state.agentLiquidity[cashUpdateMatch[1]];
    if (!data) throw new MockApiError(404, "Agent introuvable");
    data.cashBalance = asNumber(body.cashBalance, data.cashBalance);
    if (data.cashBalance < data.minCashThreshold && !data.activeAlerts.some((a: AnyRecord) => a.type === "CASH_CRITICAL")) {
      data.activeAlerts.push({
        id: nextId(state, "alert"),
        type: "CASH_CRITICAL",
        level: "CRITICAL",
        message: "Cash en dessous du seuil critique.",
        suggestedAction: "Réapprovisionnez immédiatement.",
        createdAt: nowIso(),
      });
    }
    persistState(state);
    return clone({ success: true }) as T;
  }

  const liquidityTransferMatch = pathname.match(/^\/agents\/([^/]+)\/liquidity-transfer$/);
  if (liquidityTransferMatch && method === "POST") {
    const data = state.agentLiquidity[liquidityTransferMatch[1]];
    if (!data) throw new MockApiError(404, "Agent introuvable");
    const amount = asNumber(body.amount, 0);
    if (amount <= 0) throw new MockApiError(400, "Montant invalide");
    data.floatBalance += amount;
    persistState(state);
    return clone({ success: true, transferredAmount: amount }) as T;
  }

  const resolveAlertMatch = pathname.match(/^\/agents\/([^/]+)\/alerts\/([^/]+)\/resolve$/);
  if (resolveAlertMatch && method === "PATCH") {
    const data = state.agentLiquidity[resolveAlertMatch[1]];
    if (!data) throw new MockApiError(404, "Agent introuvable");
    data.activeAlerts = data.activeAlerts.filter((a: AnyRecord) => a.id !== resolveAlertMatch[2]);
    persistState(state);
    return clone({ success: true }) as T;
  }

  // ---------------------------------------------------------------------------
  // Creator
  // ---------------------------------------------------------------------------
  const creatorDashboardMatch = pathname.match(/^\/creator\/dashboard\/([^/]+)$/);
  if (creatorDashboardMatch && method === "GET") {
    const community = state.creatorCommunities.find((c) => c.creatorId === creatorDashboardMatch[1]);
    if (!community) throw new MockApiError(404, "Aucune communauté créateur");
    return clone({
      ...community,
      memberCount: (community.memberIds ?? []).length,
    }) as T;
  }

  if (pathname === "/creator/communities" && method === "GET") {
    const limit = Math.max(1, asNumber(query.get("limit"), 30));
    const communities = state.creatorCommunities
      .map((c) => ({ ...c, memberCount: (c.memberIds ?? []).length }))
      .slice(0, limit);
    return clone({ communities }) as T;
  }

  if (pathname === "/creator/communities" && method === "POST") {
    const community = {
      id: nextId(state, "community"),
      name: body.name ?? "Nouvelle communauté",
      handle: body.handle ?? `communaute_${Date.now()}`,
      description: body.description ?? "",
      creatorId: body.creatorId ?? DEMO_USER_ID,
      creatorFeeRate: asNumber(body.creatorFeeRate, 0.05),
      platformFeeRate: asNumber(body.platformFeeRate, 0.02),
      memberIds: [body.creatorId ?? DEMO_USER_ID],
      totalEarnings: 0,
      createdAt: nowIso(),
    };
    state.creatorCommunities.unshift(community);
    persistState(state);
    return clone(community) as T;
  }

  const creatorPoolsMatch = pathname.match(/^\/creator\/communities\/([^/]+)\/pools$/);
  if (creatorPoolsMatch && method === "GET") {
    const pools = state.investmentPools.filter((pool) => pool.communityId === creatorPoolsMatch[1]);
    return clone({ pools }) as T;
  }

  const creatorJoinMatch = pathname.match(/^\/creator\/communities\/([^/]+)\/join$/);
  if (creatorJoinMatch && method === "POST") {
    const community = state.creatorCommunities.find((c) => c.id === creatorJoinMatch[1]);
    if (!community) throw new MockApiError(404, "Communauté introuvable");
    const userId = body.userId ?? DEMO_USER_ID;
    community.memberIds = community.memberIds ?? [];
    if (!community.memberIds.includes(userId)) community.memberIds.push(userId);
    persistState(state);
    return clone({ success: true }) as T;
  }

  const creatorEarningsMatch = pathname.match(/^\/creator\/communities\/([^/]+)\/earnings$/);
  if (creatorEarningsMatch && method === "POST") {
    const community = state.creatorCommunities.find((c) => c.id === creatorEarningsMatch[1]);
    if (!community) throw new MockApiError(404, "Communauté introuvable");
    const amount = asNumber(body.transactionAmount, 0);
    const creatorShare = amount * asNumber(community.creatorFeeRate, 0.05);
    const platformShare = amount * asNumber(community.platformFeeRate, 0.02);
    const memberShare = Math.max(0, amount - creatorShare - platformShare);
    community.totalEarnings = asNumber(community.totalEarnings, 0) + creatorShare;
    persistState(state);
    return clone({
      creatorShare,
      platformShare,
      memberShare,
    }) as T;
  }

  const creatorCommunityMatch = pathname.match(/^\/creator\/communities\/([^/]+)$/);
  if (creatorCommunityMatch && method === "GET") {
    const idOrHandle = creatorCommunityMatch[1];
    const community = state.creatorCommunities.find((c) => c.id === idOrHandle || c.handle === idOrHandle);
    if (!community) throw new MockApiError(404, "Communauté introuvable");
    return clone({
      ...community,
      memberCount: (community.memberIds ?? []).length,
    }) as T;
  }

  // ---------------------------------------------------------------------------
  // Investment pools
  // ---------------------------------------------------------------------------
  if (pathname === "/pools/investment" && method === "GET") {
    const limit = Math.max(1, asNumber(query.get("limit"), 50));
    return clone({ pools: state.investmentPools.slice(0, limit) }) as T;
  }

  const investMatch = pathname.match(/^\/pools\/investment\/([^/]+)\/invest$/);
  if (investMatch && method === "POST") {
    const pool = state.investmentPools.find((p) => p.id === investMatch[1]);
    if (!pool) throw new MockApiError(404, "Pool introuvable");
    const wallet = getWalletById(state, body.walletId);
    const amount = asNumber(body.amount, 0);
    if (amount <= 0) throw new MockApiError(400, "Montant invalide");
    if (wallet.availableBalance < amount) throw new MockApiError(400, "Solde insuffisant");

    const nav = asNumber(pool.nav, 1);
    const shares = amount / Math.max(nav, 0.0001);
    wallet.availableBalance -= amount;
    wallet.balance -= amount;

    let position = (pool.positions ?? []).find((pos: AnyRecord) => pos.userId === body.userId);
    if (!position) {
      position = {
        id: nextId(state, "position"),
        userId: body.userId ?? DEMO_USER_ID,
        userName: body.userId === DEMO_USER_ID ? "Compte Demo" : `Membre ${body.userId}`,
        investedAmount: 0,
        shares: 0,
        joinedAt: nowIso(),
      };
      pool.positions = pool.positions ?? [];
      pool.positions.push(position);
    }
    position.investedAmount += amount;
    position.shares += shares;
    pool.currentAmount = asNumber(pool.currentAmount, 0) + amount;

    pushTransaction(state, {
      type: "investment",
      amount,
      description: `Investissement ${pool.name}`,
      fromWalletId: wallet.id,
      toWalletId: pool.id,
      direction: "out",
    });

    persistState(state);
    return clone({
      poolId: pool.id,
      investedAmount: amount,
      amount,
      shares,
      nav,
    }) as T;
  }

  const investPoolMatch = pathname.match(/^\/pools\/investment\/([^/]+)$/);
  if (investPoolMatch && method === "GET") {
    const pool = state.investmentPools.find((p) => p.id === investPoolMatch[1]);
    if (!pool) throw new MockApiError(404, "Pool introuvable");
    return clone(pool) as T;
  }

  // ---------------------------------------------------------------------------
  // Insurance pools
  // ---------------------------------------------------------------------------
  if (pathname === "/pools/insurance" && method === "GET") {
    const limit = Math.max(1, asNumber(query.get("limit"), 50));
    return clone({ pools: state.insurancePools.slice(0, limit) }) as T;
  }

  const insuranceJoinMatch = pathname.match(/^\/pools\/insurance\/([^/]+)\/join$/);
  if (insuranceJoinMatch && method === "POST") {
    const pool = state.insurancePools.find((p) => p.id === insuranceJoinMatch[1]);
    if (!pool) throw new MockApiError(404, "Pool d'assurance introuvable");
    const wallet = getWalletById(state, body.walletId);
    const premium = asNumber(pool.premiumAmount, 0);
    if (wallet.availableBalance < premium) throw new MockApiError(400, "Solde insuffisant");

    wallet.availableBalance -= premium;
    wallet.balance -= premium;
    const policies = state.insurancePolicies[pool.id] ?? [];
    state.insurancePolicies[pool.id] = policies;

    let policy = policies.find((p) => p.userId === body.userId && p.status === "active");
    if (!policy) {
      policy = {
        id: nextId(state, "policy"),
        poolId: pool.id,
        userId: body.userId ?? DEMO_USER_ID,
        status: "active",
        nextPaymentDate: dayOffset(30),
        createdAt: nowIso(),
      };
      policies.unshift(policy);
      pool.memberCount = asNumber(pool.memberCount, 0) + 1;
    }

    persistState(state);
    return clone(policy) as T;
  }

  const insurancePoliciesMatch = pathname.match(/^\/pools\/insurance\/([^/]+)\/policies$/);
  if (insurancePoliciesMatch && method === "GET") {
    return clone({ policies: state.insurancePolicies[insurancePoliciesMatch[1]] ?? [] }) as T;
  }

  const insuranceClaimsMatch = pathname.match(/^\/pools\/insurance\/([^/]+)\/claims$/);
  if (insuranceClaimsMatch && method === "GET") {
    return clone({ claims: state.insuranceClaims[insuranceClaimsMatch[1]] ?? [] }) as T;
  }

  if (insuranceClaimsMatch && method === "POST") {
    const poolId = insuranceClaimsMatch[1];
    const claim = {
      id: nextId(state, "claim"),
      poolId,
      policyId: body.policyId,
      userId: body.userId ?? DEMO_USER_ID,
      claimAmount: asNumber(body.claimAmount, 0),
      reason: body.reason ?? "",
      status: "under_review",
      createdAt: nowIso(),
    };
    state.insuranceClaims[poolId] = state.insuranceClaims[poolId] ?? [];
    state.insuranceClaims[poolId].unshift(claim);
    persistState(state);
    return clone(claim) as T;
  }

  // ---------------------------------------------------------------------------
  // Tontines + Community routes
  // ---------------------------------------------------------------------------
  if (pathname === "/tontines/public" && method === "GET") {
    const tontines = state.tontines
      .filter((t) => t.isPublic !== false)
      .map((t) => ensureMemberCount(state, t));
    return clone({ tontines: sortByDateDesc(tontines) }) as T;
  }

  if (pathname === "/tontines" && method === "GET") {
    const userId = query.get("userId") ?? DEMO_USER_ID;
    const limit = Math.max(1, asNumber(query.get("limit"), 50));
    const tontines = state.tontines
      .filter((t) => (state.tontineMembers[t.id] ?? []).some((m) => m.userId === userId))
      .map((t) => ensureMemberCount(state, t))
      .slice(0, limit);
    return clone({ tontines }) as T;
  }

  if (pathname === "/tontines" && method === "POST") {
    const tontineId = nextId(state, "tontine");
    const tontineType = body.tontineType ?? "classic";
    const tontine = {
      id: tontineId,
      name: body.name ?? "Nouvelle tontine",
      tontineType,
      type: tontineType,
      status: "pending",
      contributionAmount: asNumber(body.contributionAmount, 0),
      frequency: body.frequency ?? "monthly",
      maxMembers: Math.max(2, asNumber(body.maxMembers, 8)),
      totalRounds: Math.max(2, asNumber(body.maxMembers, 8)),
      currentRound: 1,
      nextPayoutDate: dayOffset(7),
      nextPayoutAt: dayOffset(7),
      adminUserId: body.adminUserId ?? DEMO_USER_ID,
      isPublic: body.isPublic !== false,
      isMultiAmount: !!body.isMultiAmount,
      strategyMode: tontineType === "hybrid" || !!body.strategyMode,
      yieldRate: asNumber(body.yieldRate, 6),
      growthRate: asNumber(body.growthRate, 3),
      createdAt: nowIso(),
    };
    state.tontines.unshift(tontine);
    state.tontineMembers[tontineId] = [
      {
        id: nextId(state, "member"),
        userId: body.adminUserId ?? DEMO_USER_ID,
        payoutOrder: 1,
        hasReceivedPayout: 0,
        contributionsCount: 0,
        user: {
          firstName: state.users[DEMO_USER_ID]?.firstName ?? "Demo",
          lastName: state.users[DEMO_USER_ID]?.lastName ?? "",
          phone: state.users[DEMO_USER_ID]?.phone ?? "",
        },
      },
    ];
    if (tontineType === "project") {
      state.tontineGoals[tontineId] = [
        {
          id: nextId(state, "goal"),
          tontineId,
          goalDescription: body.goalDescription ?? "Objectif du projet",
          vendorName: body.vendorName ?? "Fournisseur",
          goalAmount: asNumber(body.goalAmount, 100_000),
          currentAmount: 0,
          status: "open",
        },
      ];
    }
    persistState(state);
    return clone({ tontine }) as T;
  }

  const tontineMembersMatch = pathname.match(/^\/tontines\/([^/]+)\/members$/);
  if (tontineMembersMatch && method === "GET") {
    return clone({ members: state.tontineMembers[tontineMembersMatch[1]] ?? [] }) as T;
  }

  const tontineDetailMatch = pathname.match(/^\/tontines\/([^/]+)$/);
  if (tontineDetailMatch && method === "GET") {
    const tontine = state.tontines.find((t) => t.id === tontineDetailMatch[1]);
    if (!tontine) throw new MockApiError(404, "Tontine introuvable");
    return clone({ tontine: ensureMemberCount(state, tontine) }) as T;
  }

  if (pathname === "/community/tontines/positions" && method === "GET") {
    return clone({ listings: sortByDateDesc(state.tontineListings) }) as T;
  }

  const buyListingMatch = pathname.match(/^\/community\/tontines\/positions\/([^/]+)\/buy$/);
  if (buyListingMatch && method === "POST") {
    const index = state.tontineListings.findIndex((l) => l.id === buyListingMatch[1]);
    if (index < 0) throw new MockApiError(404, "Listing introuvable");
    const listing = state.tontineListings[index];
    const buyerWallet = getUserWallet(state, body.buyerId ?? DEMO_USER_ID);
    const askPrice = asNumber(listing.askPrice, 0);
    if (buyerWallet.availableBalance < askPrice) {
      throw new MockApiError(400, "Solde insuffisant pour acheter cette position");
    }
    buyerWallet.availableBalance -= askPrice;
    buyerWallet.balance -= askPrice;
    state.tontineListings.splice(index, 1);
    pushTransaction(state, {
      type: "tontine",
      amount: askPrice,
      description: `Achat position #${listing.payoutOrder}`,
      fromWalletId: buyerWallet.id,
      toWalletId: `seller:${listing.sellerId}`,
      direction: "out",
    });
    persistState(state);
    return clone({ success: true }) as T;
  }

  const activateMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/activate$/);
  if (activateMatch && method === "POST") {
    const tontine = state.tontines.find((t) => t.id === activateMatch[1]);
    if (!tontine) throw new MockApiError(404, "Tontine introuvable");
    tontine.status = "active";
    persistState(state);
    return clone({ success: true, tontine }) as T;
  }

  const hybridConfigMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/hybrid-config$/);
  if (hybridConfigMatch && method === "POST") {
    state.tontineHybrid[hybridConfigMatch[1]] = {
      hybridConfig: {
        rotation_pct: asNumber(body.rotation_pct, 60),
        investment_pct: asNumber(body.investment_pct, 20),
        solidarity_pct: asNumber(body.solidarity_pct, 10),
        yield_pct: asNumber(body.yield_pct, 10),
      },
      solidarityReserveBalance: asNumber(body.solidarityReserveBalance, 15_000),
    };
    persistState(state);
    return clone({ success: true }) as T;
  }

  const joinTontineMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/members$/);
  if (joinTontineMatch && method === "POST") {
    const tontine = state.tontines.find((t) => t.id === joinTontineMatch[1]);
    if (!tontine) throw new MockApiError(404, "Tontine introuvable");
    const userId = body.userId ?? DEMO_USER_ID;
    const members = state.tontineMembers[tontine.id] ?? [];
    if (!members.some((m) => m.userId === userId)) {
      members.push({
        id: nextId(state, "member"),
        userId,
        payoutOrder: members.length + 1,
        hasReceivedPayout: 0,
        contributionsCount: 0,
        user: {
          firstName: userId === DEMO_USER_ID ? "Compte" : "Membre",
          lastName: userId === DEMO_USER_ID ? "Demo" : userId.slice(0, 4),
          phone: "+0000000000",
        },
      });
      state.tontineMembers[tontine.id] = members;
    }
    persistState(state);
    return clone({ success: true, members }) as T;
  }

  const listPositionMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/positions\/list$/);
  if (listPositionMatch && method === "POST") {
    const tontineId = listPositionMatch[1];
    const tontine = state.tontines.find((t) => t.id === tontineId);
    if (!tontine) throw new MockApiError(404, "Tontine introuvable");
    const sellerId = body.sellerId ?? DEMO_USER_ID;
    const seller = (state.tontineMembers[tontineId] ?? []).find((m) => m.userId === sellerId);
    const listing = {
      id: nextId(state, "listing"),
      tontineId,
      tontineName: tontine.name,
      payoutOrder: seller?.payoutOrder ?? 1,
      askPrice: asNumber(body.askPrice, asNumber(tontine.contributionAmount, 0)),
      sellerId,
      createdAt: nowIso(),
    };
    state.tontineListings.unshift(listing);
    persistState(state);
    return clone(listing) as T;
  }

  const marketByTontineMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/positions\/market$/);
  if (marketByTontineMatch && method === "GET") {
    const listings = state.tontineListings.filter((l) => l.tontineId === marketByTontineMatch[1]);
    return clone({ listings }) as T;
  }

  const bidsMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/bids$/);
  if (bidsMatch && method === "GET") {
    return clone({ bids: state.tontineBids[bidsMatch[1]] ?? [] }) as T;
  }

  if (bidsMatch && method === "POST") {
    const bid = {
      id: nextId(state, "bid"),
      tontineId: bidsMatch[1],
      userId: body.userId ?? DEMO_USER_ID,
      bidAmount: asNumber(body.bidAmount, 0),
      desiredPosition: Math.max(1, asNumber(body.desiredPosition, 1)),
      createdAt: nowIso(),
    };
    state.tontineBids[bidsMatch[1]] = state.tontineBids[bidsMatch[1]] ?? [];
    state.tontineBids[bidsMatch[1]].push(bid);
    persistState(state);
    return clone(bid) as T;
  }

  const collectMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/collect$/);
  if (collectMatch && method === "POST") {
    const tontine = state.tontines.find((t) => t.id === collectMatch[1]);
    if (!tontine) throw new MockApiError(404, "Tontine introuvable");
    const amount = asNumber(tontine.contributionAmount, 0);
    const wallet = getUserWallet(state, body.userId ?? DEMO_USER_ID);
    if (wallet.availableBalance < amount) throw new MockApiError(400, "Solde insuffisant");
    wallet.availableBalance -= amount;
    wallet.balance -= amount;
    const members = state.tontineMembers[tontine.id] ?? [];
    const member = members.find((m) => m.userId === (body.userId ?? DEMO_USER_ID));
    if (member) member.contributionsCount = asNumber(member.contributionsCount, 0) + 1;
    tontine.currentRound = Math.min(asNumber(tontine.totalRounds, 1), asNumber(tontine.currentRound, 1) + 1);
    tontine.nextPayoutDate = dayOffset(7);
    tontine.nextPayoutAt = tontine.nextPayoutDate;
    pushTransaction(state, {
      type: "tontine",
      amount,
      description: `Cotisation ${tontine.name}`,
      fromWalletId: wallet.id,
      toWalletId: `tontine:${tontine.id}`,
      direction: "out",
    });
    persistState(state);
    return clone({ success: true }) as T;
  }

  const goalsMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/goals$/);
  if (goalsMatch && method === "GET") {
    return clone(state.tontineGoals[goalsMatch[1]] ?? []) as T;
  }

  const goalReleaseMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/goals\/([^/]+)\/release$/);
  if (goalReleaseMatch && method === "POST") {
    const goals = state.tontineGoals[goalReleaseMatch[1]] ?? [];
    const goal = goals.find((g) => g.id === goalReleaseMatch[2]);
    if (!goal) throw new MockApiError(404, "Objectif introuvable");
    goal.status = "released";
    persistState(state);
    return clone({ success: true, goal }) as T;
  }

  const yieldSummaryMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/yield-summary$/);
  if (yieldSummaryMatch && method === "GET") {
    const tontine = state.tontines.find((t) => t.id === yieldSummaryMatch[1]);
    if (!tontine) throw new MockApiError(404, "Tontine introuvable");
    const members = state.tontineMembers[tontine.id] ?? [];
    const poolBalance = asNumber(tontine.contributionAmount, 0) * members.length * 0.12;
    return clone({
      poolBalance,
      annualYieldRate: asNumber(tontine.yieldRate, 6),
    }) as T;
  }

  const growthProjectionMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/growth-projection$/);
  if (growthProjectionMatch && method === "GET") {
    const tontine = state.tontines.find((t) => t.id === growthProjectionMatch[1]);
    if (!tontine) throw new MockApiError(404, "Tontine introuvable");
    const rate = asNumber(tontine.growthRate, 3) / 100;
    const base = asNumber(tontine.contributionAmount, 0);
    const projection = Array.from({ length: 6 }).map((_, idx) => ({
      cycle: idx + 1,
      amount: Math.round(base * Math.pow(1 + rate, idx)),
    }));
    return clone({ projection }) as T;
  }

  const hybridSummaryMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/hybrid-summary$/);
  if (hybridSummaryMatch && method === "GET") {
    const summary = state.tontineHybrid[hybridSummaryMatch[1]] ?? {
      hybridConfig: { rotation_pct: 60, investment_pct: 20, solidarity_pct: 10, yield_pct: 10 },
      solidarityReserveBalance: 0,
    };
    return clone(summary) as T;
  }

  const strategyTargetsMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/strategy\/targets$/);
  if (strategyTargetsMatch && method === "GET") {
    const merchants = state.merchants.slice(0, 2);
    const targets = (merchants.length > 0 ? merchants : [{ id: "merchant-sim-1", businessName: "Boutique Simulée" }]).map((merchant, idx) => ({
      id: `target-${idx + 1}`,
      merchantId: merchant.id,
      allocatedAmount: 40_000 + idx * 15_000,
      performanceScore: 72 + idx * 6,
      merchant: { businessName: merchant.businessName },
    }));
    return clone({ targets }) as T;
  }

  const aiAssessmentMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/ai-assessment$/);
  if (aiAssessmentMatch && method === "GET") {
    const members = state.tontineMembers[aiAssessmentMatch[1]] ?? [];
    const rankedMembers = [...members]
      .sort((a, b) => asNumber(b.contributionsCount, 0) - asNumber(a.contributionsCount, 0))
      .map((member, index) => ({
        userId: member.userId,
        rank: index + 1,
        priorityScore: Math.max(50, 92 - index * 7),
        recommendation: index === 0 ? "Priorité haute: régularité exemplaire." : "Profil stable pour le cycle en cours.",
      }));
    return clone({ rankedMembers }) as T;
  }

  const aiApplyMatch = pathname.match(/^\/community\/tontines\/([^/]+)\/apply-ai-order$/);
  if (aiApplyMatch && method === "POST") {
    const members = state.tontineMembers[aiApplyMatch[1]] ?? [];
    members.sort((a, b) => asNumber(b.contributionsCount, 0) - asNumber(a.contributionsCount, 0));
    members.forEach((member, idx) => {
      member.payoutOrder = idx + 1;
    });
    persistState(state);
    return clone({ success: true }) as T;
  }

  throwNotFound(pathname);
}
