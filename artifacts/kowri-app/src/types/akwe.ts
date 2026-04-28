export type TontineStatus = "pending" | "active" | "completed" | "cancelled";
export type TontineFrequency = "weekly" | "biweekly" | "monthly";

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
  status: TontineStatus;
  frequency: TontineFrequency;
  tontineType: string;
  contributionAmount: number;
  memberCount: number;
  maxMembers: number;
  currentRound: number;
  totalRounds: number;
  nextPayoutDate?: string | null;
}

export interface TontineMember {
  userId: string;
  userName: string;
  payoutOrder: number;
  contributionsCount: number;
  hasReceivedPayout: boolean;
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
