import { ApiError, apiFetch } from "@/lib/api";
import type { WalletSummary, WalletTransaction } from "@/types/akwe";

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildMockWallet(userId: string): WalletSummary {
  return {
    id: "mock-wallet-akwe",
    userId,
    currency: "XOF",
    walletType: "principal",
    status: "active",
    balance: 835000,
    availableBalance: 799500,
  };
}

function buildMockTransactions(walletId: string): WalletTransaction[] {
  return [
    {
      id: "tx-1",
      type: "tontine_payout",
      status: "completed",
      amount: 300000,
      description: "Payout tontine Solidarite Famille",
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      toWalletId: walletId,
    },
    {
      id: "tx-2",
      type: "transfer",
      status: "completed",
      amount: 25000,
      description: "Transfert vers +22670000001",
      createdAt: new Date(Date.now() - 172_800_000).toISOString(),
      fromWalletId: walletId,
    },
    {
      id: "tx-3",
      type: "deposit",
      status: "completed",
      amount: 150000,
      description: "Depot agent Ouaga Centre",
      createdAt: new Date(Date.now() - 259_200_000).toISOString(),
      toWalletId: walletId,
    },
  ];
}

export async function getPrimaryWallet(
  token: string | null,
  userId: string,
): Promise<{ wallet: WalletSummary; usingMock: boolean }> {
  try {
    const data = await apiFetch<{ wallets?: unknown[] }>(
      `/wallets?userId=${encodeURIComponent(userId)}&limit=1`,
      token,
    );
    const rawWallet = data.wallets?.[0] as Record<string, unknown> | undefined;
    if (!rawWallet) {
      return { wallet: buildMockWallet(userId), usingMock: true };
    }
    return {
      wallet: {
        id: String(rawWallet.id ?? "wallet-unknown"),
        userId: String(rawWallet.userId ?? userId),
        currency: String(rawWallet.currency ?? "XOF"),
        walletType: String(rawWallet.walletType ?? "principal"),
        status: String(rawWallet.status ?? "active"),
        balance: toNumber(rawWallet.balance),
        availableBalance: toNumber(rawWallet.availableBalance),
      },
      usingMock: false,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return { wallet: buildMockWallet(userId), usingMock: true };
    }
    throw error;
  }
}

export async function getWalletTransactions(
  token: string | null,
  walletId: string,
  limit = 20,
): Promise<{ transactions: WalletTransaction[]; usingMock: boolean }> {
  try {
    const data = await apiFetch<{ transactions?: unknown[] }>(
      `/transactions?walletId=${encodeURIComponent(walletId)}&limit=${limit}`,
      token,
    );
    const transactions = (data.transactions ?? []).map((row) => {
      const tx = row as Record<string, unknown>;
      return {
        id: String(tx.id ?? randomId()),
        type: String(tx.type ?? "transfer"),
        status: String(tx.status ?? "completed"),
        amount: toNumber(tx.amount),
        description: String(tx.description ?? "Transaction"),
        createdAt: String(tx.createdAt ?? new Date().toISOString()),
        fromWalletId: tx.fromWalletId ? String(tx.fromWalletId) : null,
        toWalletId: tx.toWalletId ? String(tx.toWalletId) : null,
      };
    });
    return { transactions, usingMock: false };
  } catch (error) {
    if (error instanceof ApiError) {
      return { transactions: buildMockTransactions(walletId), usingMock: true };
    }
    throw error;
  }
}

export async function depositToWallet(
  token: string | null,
  walletId: string,
  amount: number,
): Promise<void> {
  await apiFetch(`/wallets/${encodeURIComponent(walletId)}/deposit`, token, {
    method: "POST",
    headers: { "Idempotency-Key": `${Date.now()}-deposit` },
    body: JSON.stringify({
      amount,
      currency: "XOF",
      description: "Depot wallet Akwé",
    }),
  });
}
