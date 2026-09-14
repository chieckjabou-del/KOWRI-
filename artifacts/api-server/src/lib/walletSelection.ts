import { db } from "@workspace/db";
import { walletsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

/**
 * Pick the wallet a member should be debited from for a tontine obligation.
 * Only active wallets in the tontine currency qualify (never the pool wallet);
 * among them the first wallet that can actually cover `amount` wins, personal
 * wallets first, so a user holding several wallets is not debited from an
 * empty one while a funded one sits next to it.
 */
export async function pickDebitWallet(
  userId: string,
  currency: string,
  amount: number,
  excludeWalletId: string | null,
): Promise<typeof walletsTable.$inferSelect | null> {
  const wallets = (await db.select().from(walletsTable)
    .where(and(eq(walletsTable.userId, userId), eq(walletsTable.status, "active"))))
    .filter(w => w.currency === currency && w.id !== excludeWalletId && w.walletType !== "tontine");
  const rank = (w: typeof walletsTable.$inferSelect) => (w.walletType === "personal" ? 0 : 1);
  wallets.sort((a, b) => rank(a) - rank(b) || Number(b.balance) - Number(a.balance));
  return wallets.find(w => Number(w.balance) >= amount) ?? wallets[0] ?? null;
}
