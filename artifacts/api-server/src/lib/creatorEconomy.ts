import { db } from "@workspace/db";
import {
  creatorCommunitiesTable, walletsTable, usersTable,
  investmentPoolsTable, tontinesTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { generateId } from "./id";
import { processDeposit } from "./walletService";
import { eventBus } from "./eventBus";
import { audit } from "./auditLogger";

export async function createCommunity(params: {
  name: string; description?: string; creatorId: string; handle: string;
  platformFeeRate?: number; creatorFeeRate?: number;
}): Promise<typeof creatorCommunitiesTable.$inferSelect> {
  const existing = await db.select({ id: creatorCommunitiesTable.id })
    .from(creatorCommunitiesTable)
    .where(eq(creatorCommunitiesTable.handle, params.handle));
  if (existing.length > 0) throw new Error("Handle already taken");

  const communityWalletId = generateId();
  const [creator] = await db.select().from(usersTable).where(eq(usersTable.id, params.creatorId));
  if (!creator) throw new Error("Creator not found");

  await db.insert(walletsTable).values({
    id:               communityWalletId,
    userId:           params.creatorId,
    currency:         "XOF",
    balance:          "0",
    availableBalance: "0",
    status:           "active",
    walletType:       "merchant",
    createdAt:        new Date(),
    updatedAt:        new Date(),
  });

  const [community] = await db.insert(creatorCommunitiesTable).values({
    id:              generateId(),
    name:            params.name,
    description:     params.description ?? null,
    creatorId:       params.creatorId,
    handle:          params.handle,
    walletId:        communityWalletId,
    platformFeeRate: String(params.platformFeeRate ?? 2),
    creatorFeeRate:  String(params.creatorFeeRate ?? 5),
  }).returning();

  await audit({ action: "community.created", entity: "creator_community", entityId: community.id,
    metadata: { creatorId: params.creatorId, handle: params.handle } });
  await eventBus.publish("creator.community.created", { communityId: community.id, creatorId: params.creatorId });
  return community;
}

export async function getCommunity(handleOrId: string) {
  const byHandle = await db.select().from(creatorCommunitiesTable)
    .where(eq(creatorCommunitiesTable.handle, handleOrId));
  if (byHandle[0]) return formatCommunity(byHandle[0]);

  const byId = await db.select().from(creatorCommunitiesTable)
    .where(eq(creatorCommunitiesTable.id, handleOrId));
  if (byId[0]) return formatCommunity(byId[0]);

  return null;
}

function formatCommunity(c: typeof creatorCommunitiesTable.$inferSelect) {
  return {
    ...c,
    platformFeeRate: Number(c.platformFeeRate),
    creatorFeeRate:  Number(c.creatorFeeRate),
    totalVolume:     Number(c.totalVolume),
  };
}

export async function listCommunities(page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const rows = await db.select().from(creatorCommunitiesTable)
    .where(eq(creatorCommunitiesTable.status, "active"))
    .limit(limit).offset(offset)
    .orderBy(sql`${creatorCommunitiesTable.memberCount} DESC`);
  return rows.map(formatCommunity);
}

export async function joinCommunity(communityId: string, userId: string): Promise<void> {
  const [community] = await db.select().from(creatorCommunitiesTable)
    .where(eq(creatorCommunitiesTable.id, communityId));
  if (!community) throw new Error("Community not found");

  await db.update(creatorCommunitiesTable).set({
    memberCount: sql`${creatorCommunitiesTable.memberCount} + 1`,
    updatedAt: new Date(),
  }).where(eq(creatorCommunitiesTable.id, communityId));

  await eventBus.publish("creator.community.joined", { communityId, userId });
}

export async function distributeCreatorEarnings(communityId: string, transactionAmount: number, currency: string): Promise<{
  platformFee: number; creatorFee: number;
}> {
  const [community] = await db.select().from(creatorCommunitiesTable)
    .where(eq(creatorCommunitiesTable.id, communityId));
  if (!community) throw new Error("Community not found");

  const platformFee = transactionAmount * (Number(community.platformFeeRate) / 100);
  const creatorFee  = transactionAmount * (Number(community.creatorFeeRate)  / 100);

  const [creatorWallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.userId, community.creatorId), eq(walletsTable.status, "active")));

  if (creatorWallet && creatorFee > 0) {
    await processDeposit({
      walletId:    creatorWallet.id,
      amount:      creatorFee,
      currency,
      reference:   `CREATOR-FEE-${communityId}-${Date.now()}`,
      description: `Creator commission – ${community.name}`,
    });
  }

  await db.update(creatorCommunitiesTable).set({
    totalVolume: sql`COALESCE(${creatorCommunitiesTable.totalVolume}, '0')::numeric + ${String(transactionAmount)}`,
    updatedAt: new Date(),
  }).where(eq(creatorCommunitiesTable.id, communityId));

  await eventBus.publish("creator.earnings.distributed", {
    communityId, transactionAmount, platformFee, creatorFee, currency,
  });

  return { platformFee, creatorFee };
}

export async function getCommunityPools(communityId: string) {
  const [community] = await db.select().from(creatorCommunitiesTable)
    .where(eq(creatorCommunitiesTable.id, communityId));
  if (!community) throw new Error("Community not found");

  const pools = await db.select().from(investmentPoolsTable)
    .where(eq(investmentPoolsTable.managerId, community.creatorId));

  const tontines = await db.select().from(tontinesTable)
    .where(eq(tontinesTable.adminUserId, community.creatorId));

  return {
    community: formatCommunity(community),
    investmentPools: pools.map(p => ({
      ...p,
      goalAmount:    Number(p.goalAmount),
      currentAmount: Number(p.currentAmount),
      minInvestment: Number(p.minInvestment),
    })),
    tontines: tontines.map(t => ({
      ...t,
      contributionAmount: Number(t.contributionAmount),
    })),
  };
}

export async function getCreatorDashboard(creatorId: string) {
  const communities = await db.select().from(creatorCommunitiesTable)
    .where(eq(creatorCommunitiesTable.creatorId, creatorId));

  const totalMembers = communities.reduce((s, c) => s + c.memberCount, 0);
  const totalVolume  = communities.reduce((s, c) => s + Number(c.totalVolume), 0);
  const totalEarnings = communities.reduce((c, comm) =>
    c + (Number(comm.totalVolume) * Number(comm.creatorFeeRate) / 100), 0);

  return {
    communities: communities.map(formatCommunity),
    stats: { totalCommunities: communities.length, totalMembers, totalVolume, totalEarnings },
  };
}
