import { ApiError, apiFetch } from "@/lib/api";
import { getPrimaryWallet, getWalletTransactions } from "@/services/api/walletService";
import { listUserTontines } from "@/services/api/tontineService";
import type { DashboardNotification, TontineListItem, WalletSummary, WalletTransaction } from "@/types/akwe";

type DashboardAggregatePayload = {
  primaryWallet?: unknown;
  transactions?: unknown[];
  tontines?: unknown[];
  notifications?: unknown[];
};

export interface DashboardAggregateData {
  wallet: WalletSummary;
  transactions: WalletTransaction[];
  tontines: TontineListItem[];
  notifications: DashboardNotification[];
  usingMock: boolean;
  source: "aggregate" | "composed";
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function mapWallet(raw: unknown): WalletSummary {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    id: toString(row.id, "wallet-unknown"),
    userId: toString(row.userId, "user-unknown"),
    currency: toString(row.currency, "XOF"),
    walletType: toString(row.walletType, "principal"),
    status: toString(row.status, "active"),
    balance: toNumber(row.balance),
    availableBalance: toNumber(row.availableBalance),
  };
}

function mapTransactions(rawRows: unknown[] | undefined): WalletTransaction[] {
  return (rawRows ?? []).map((row) => {
    const tx = row as Record<string, unknown>;
    return {
      id: toString(tx.id, randomId()),
      type: toString(tx.type, "transfer"),
      status: toString(tx.status, "completed"),
      amount: toNumber(tx.amount),
      description: toString(tx.description, "Transaction"),
      createdAt: toString(tx.createdAt, new Date().toISOString()),
      fromWalletId: tx.fromWalletId ? toString(tx.fromWalletId) : null,
      toWalletId: tx.toWalletId ? toString(tx.toWalletId) : null,
    };
  });
}

function mapTontines(rawRows: unknown[] | undefined): TontineListItem[] {
  return (rawRows ?? []).map((row, index) => {
    const item = row as Record<string, unknown>;
    return {
      id: toString(item.id, `tontine-${index}`),
      name: toString(item.name, "Tontine"),
      description: item.description ? toString(item.description) : null,
      status: toString(item.status, "pending") as TontineListItem["status"],
      frequency: toString(item.frequency, "monthly") as TontineListItem["frequency"],
      tontineType: toString(item.tontineType, "classic"),
      contributionAmount: toNumber(item.contributionAmount),
      memberCount: toNumber(item.memberCount),
      maxMembers: toNumber(item.maxMembers),
      currentRound: toNumber(item.currentRound),
      totalRounds: toNumber(item.totalRounds, toNumber(item.maxMembers)),
      isPublic: item.isPublic != null ? Boolean(item.isPublic) : undefined,
      isMultiAmount: item.isMultiAmount != null ? Boolean(item.isMultiAmount) : undefined,
      adminUserId: item.adminUserId ? toString(item.adminUserId) : undefined,
      createdAt: item.createdAt ? toString(item.createdAt) : undefined,
      nextPayoutDate: item.nextPayoutDate ? toString(item.nextPayoutDate) : null,
    };
  });
}

function mapNotifications(rawRows: unknown[] | undefined): DashboardNotification[] {
  return (rawRows ?? []).map((row) => {
    const notif = row as Record<string, unknown>;
    return {
      id: toString(notif.id, randomId()),
      title: toString(notif.title, "Notification"),
      message: toString(notif.message, ""),
      type: toString(notif.type, "info"),
      read: Boolean(notif.read),
      createdAt: toString(notif.createdAt, new Date().toISOString()),
    };
  });
}

async function fetchComposed(
  token: string | null,
  userId: string,
): Promise<DashboardAggregateData> {
  const walletResult = await getPrimaryWallet(token, userId);
  const txResult = await getWalletTransactions(token, walletResult.wallet.id, 8);
  const tontineResult = await listUserTontines(token);
  return {
    wallet: walletResult.wallet,
    transactions: txResult.transactions,
    tontines: tontineResult.tontines,
    notifications: [],
    usingMock: Boolean(walletResult.usingMock || txResult.usingMock || tontineResult.usingMock),
    source: "composed",
  };
}

export async function getDashboardHomeData(
  token: string | null,
  userId: string,
): Promise<DashboardAggregateData> {
  try {
    const payload = await apiFetch<DashboardAggregatePayload>("/dashboard?txLimit=8&tontineLimit=8", token, {
      policy: { retries: 0 },
    });
    if (!payload?.primaryWallet) {
      return fetchComposed(token, userId);
    }
    return {
      wallet: mapWallet(payload.primaryWallet),
      transactions: mapTransactions(payload.transactions),
      tontines: mapTontines(payload.tontines),
      notifications: mapNotifications(payload.notifications),
      usingMock: false,
      source: "aggregate",
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return fetchComposed(token, userId);
    }
    throw error;
  }
}
