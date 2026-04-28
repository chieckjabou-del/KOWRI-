export type TontineStatus = "pending" | "active" | "completed" | "cancelled";
export type TontineFrequency = "weekly" | "biweekly" | "monthly";
export type RotationModel = "fixed" | "random" | "auction" | "admin";

export interface WalletSummary {
  id: string;
  userId: string;
  currency: string;
  walletType: string;
  status: string;
  balance: number;
  availableBalance: number;
}

export interface WalletTransaction {
  id: string;
  type: string;
  status: string;
  amount: number;
  description: string;
  createdAt: string;
  fromWalletId?: string | null;
  toWalletId?: string | null;
}

export interface TontineListItem {
  id: string;
  name: string;
  description?: string | null;
  status: TontineStatus;
  frequency: TontineFrequency;
  tontineType: string;
  contributionAmount: number;
  memberCount: number;
  maxMembers: number;
  currentRound: number;
  totalRounds: number;
  isPublic?: boolean;
  isMultiAmount?: boolean;
  adminUserId?: string;
  createdAt?: string;
  nextPayoutDate?: string | null;
}

export interface TontineMember {
  userId: string;
  userName: string;
  payoutOrder: number;
  contributionsCount: number;
  hasReceivedPayout: boolean;
  personalContribution?: number | null;
  reliabilityScore: number;
  reliabilityLabel: "excellent" | "good" | "watch";
  paymentStatus: "paid" | "late";
}

export interface TontineTimelineEvent {
  id: string;
  title: string;
  subtitle: string;
  status: "done" | "current" | "upcoming";
  dateLabel: string;
}

export interface TontineOverview {
  id: string;
  name: string;
  description?: string | null;
  status: TontineStatus;
  frequency: TontineFrequency;
  tontineType: string;
  contributionAmount: number;
  currentRound: number;
  totalRounds: number;
  memberCount: number;
  maxMembers: number;
  nextReceiver?: TontineMember;
  nextPayoutDate?: string | null;
  members: TontineMember[];
  timeline: TontineTimelineEvent[];
  history: TontineTimelineEvent[];
  notifications: string[];
}

export interface CreatorCommunity {
  id: string;
  name: string;
  description?: string | null;
  creatorId: string;
  handle: string;
  memberCount: number;
  walletId?: string | null;
  platformFeeRate: number;
  creatorFeeRate: number;
  totalVolume: number;
  status: string;
}

export interface CreatorDashboardStats {
  totalCommunities: number;
  totalMembers: number;
  totalVolume: number;
  totalEarnings: number;
}

export interface CreatorDashboard {
  communities: CreatorCommunity[];
  stats: CreatorDashboardStats;
}
