import type { WalletTransaction } from "@/types/akwe";

export function transactionDirection(
  tx: WalletTransaction,
  walletId: string,
): "incoming" | "outgoing" {
  if (tx.toWalletId && tx.toWalletId === walletId) {
    return "incoming";
  }
  if (tx.fromWalletId && tx.fromWalletId === walletId) {
    return "outgoing";
  }
  if (tx.type === "deposit" || tx.type === "tontine_payout") {
    return "incoming";
  }
  return "outgoing";
}

export function walletActivityPreview(transactions: WalletTransaction[]): WalletTransaction[] {
  return [...transactions]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 4);
}
