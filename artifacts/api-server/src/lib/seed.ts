import { db } from "@workspace/db";
import {
  usersTable, walletsTable, transactionsTable, ledgerEntriesTable,
  tontinesTable, tontineMembersTable, creditScoresTable, loansTable,
  merchantsTable, kycRecordsTable
} from "@workspace/db";
import { generateId, generateReference, generateApiKey } from "./id";
import { eq } from "drizzle-orm";

export async function seedDatabase() {
  const existingUsers = await db.select().from(usersTable).limit(1);
  if (existingUsers.length > 0) return;

  const countries = ["CI", "SN", "GH", "CM", "BF", "ML", "NG", "TG"];
  const firstNames = ["Kofi", "Amara", "Fatou", "Moussa", "Aïcha", "Kwame", "Safi", "Ibrahim", "Awa", "Seydou", "Mariama", "Cheikh"];
  const lastNames = ["Diallo", "Traoré", "Konaté", "Coulibaly", "Mensah", "Asante", "Ndiaye", "Touré", "Bah", "Keita", "Cissé", "Ouédraogo"];

  const userIds = Array.from({ length: 20 }, () => generateId());
  const walletIds = Array.from({ length: 20 }, () => generateId());
  const now = new Date();

  const users = userIds.map((id, i) => ({
    id,
    phone: `+2250${700000000 + i}`,
    email: i % 3 === 0 ? `user${i}@kowri.africa` : null,
    firstName: firstNames[i % firstNames.length],
    lastName: lastNames[i % lastNames.length],
    status: (i < 15 ? "active" : i < 18 ? "suspended" : "pending_kyc") as "active" | "suspended" | "pending_kyc",
    kycLevel: i < 10 ? 2 : i < 15 ? 1 : 0,
    country: countries[i % countries.length],
    pinHash: "hashed_pin_placeholder",
    creditScore: i < 15 ? 300 + (i * 35) : null,
    createdAt: new Date(now.getTime() - (20 - i) * 7 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
  }));

  await db.insert(usersTable).values(users);

  const wallets = walletIds.map((id, i) => ({
    id,
    userId: userIds[i],
    currency: i % 5 === 0 ? "XAF" : "XOF",
    balance: (Math.random() * 500000 + 10000).toFixed(4),
    availableBalance: (Math.random() * 400000 + 8000).toFixed(4),
    status: "active" as "active",
    walletType: "personal" as "personal",
    createdAt: users[i].createdAt,
    updatedAt: new Date(),
  }));

  await db.insert(walletsTable).values(wallets);

  const kycRecords = users.slice(0, 16).map((u, i) => ({
    id: generateId(),
    userId: u.id,
    documentType: (["national_id", "passport", "drivers_license"] as const)[i % 3],
    status: (i < 10 ? "verified" : i < 14 ? "pending" : "rejected") as "pending" | "verified" | "rejected" | "expired",
    kycLevel: u.kycLevel,
    documentNumber: `DOC-${100000 + i}`,
    rejectionReason: i >= 14 ? "Document blurred or unreadable" : null,
    verifiedAt: i < 10 ? new Date(now.getTime() - (15 - i) * 24 * 60 * 60 * 1000) : null,
    submittedAt: new Date(now.getTime() - (18 - i) * 24 * 60 * 60 * 1000),
  }));

  await db.insert(kycRecordsTable).values(kycRecords);

  const transactionData = [];
  const ledgerData = [];
  const txTypes = ["deposit", "transfer", "tontine_contribution", "merchant_payment", "loan_disbursement"] as const;

  for (let i = 0; i < 60; i++) {
    const txId = generateId();
    const fromIdx = Math.floor(Math.random() * 18);
    const toIdx = (fromIdx + 1 + Math.floor(Math.random() * 17)) % 20;
    const amount = (Math.random() * 50000 + 1000).toFixed(4);
    const type = txTypes[i % txTypes.length];
    const daysAgo = Math.floor(Math.random() * 30);
    const txDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);

    transactionData.push({
      id: txId,
      fromWalletId: type !== "deposit" ? walletIds[fromIdx] : null,
      toWalletId: walletIds[toIdx],
      amount,
      currency: "XOF",
      type,
      status: "completed" as const,
      reference: generateReference(),
      description: `${type.replace(/_/g, " ")} transaction`,
      metadata: null,
      createdAt: txDate,
      completedAt: txDate,
    });

    ledgerData.push(
      {
        id: generateId(),
        transactionId: txId,
        accountId: type !== "deposit" ? walletIds[fromIdx] : "platform_float",
        accountType: "wallet",
        debitAmount: amount,
        creditAmount: "0",
        currency: "XOF",
        eventType: type,
        description: `Debit: ${type}`,
        createdAt: txDate,
      },
      {
        id: generateId(),
        transactionId: txId,
        accountId: walletIds[toIdx],
        accountType: "wallet",
        debitAmount: "0",
        creditAmount: amount,
        currency: "XOF",
        eventType: type,
        description: `Credit: ${type}`,
        createdAt: txDate,
      }
    );
  }

  await db.insert(transactionsTable).values(transactionData);
  await db.insert(ledgerEntriesTable).values(ledgerData);

  const tontineId = generateId();
  const tontineWalletId = generateId();

  await db.insert(walletsTable).values({
    id: tontineWalletId,
    userId: userIds[0],
    currency: "XOF",
    balance: "600000.0000",
    availableBalance: "600000.0000",
    status: "active",
    walletType: "tontine",
  });

  await db.insert(tontinesTable).values({
    id: tontineId,
    name: "Diaspora Savings Circle",
    description: "Monthly savings group for West African diaspora members",
    contributionAmount: "50000.0000",
    currency: "XOF",
    frequency: "monthly",
    maxMembers: 10,
    memberCount: 8,
    currentRound: 4,
    totalRounds: 10,
    status: "active",
    adminUserId: userIds[0],
    walletId: tontineWalletId,
    nextPayoutDate: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000),
  });

  const tontineId2 = generateId();
  await db.insert(tontinesTable).values({
    id: tontineId2,
    name: "Abidjan Traders Pool",
    description: "Weekly savings for market traders in Abidjan",
    contributionAmount: "15000.0000",
    currency: "XOF",
    frequency: "weekly",
    maxMembers: 6,
    memberCount: 6,
    currentRound: 2,
    totalRounds: 6,
    status: "active",
    adminUserId: userIds[1],
    walletId: null,
    nextPayoutDate: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
  });

  const tontineMembers = userIds.slice(0, 8).map((userId, i) => ({
    id: generateId(),
    tontineId,
    userId,
    payoutOrder: i + 1,
    hasReceivedPayout: i < 4 ? 1 : 0,
    contributionsCount: 4,
  }));

  await db.insert(tontineMembersTable).values(tontineMembers);

  const creditScores = userIds.slice(0, 15).map((userId, i) => ({
    id: generateId(),
    userId,
    score: 300 + i * 35,
    tier: (i < 4 ? "bronze" : i < 8 ? "silver" : i < 12 ? "gold" : "platinum") as "bronze" | "silver" | "gold" | "platinum",
    maxLoanAmount: ((i + 1) * 25000).toFixed(4),
    interestRate: (15 - i * 0.5 > 5 ? 15 - i * 0.5 : 5).toFixed(2),
    paymentHistory: Math.min(100, i * 8),
    savingsRegularity: Math.min(100, i * 7),
    transactionVolume: Math.min(100, i * 7 + 10),
    tontineParticipation: i < 8 ? 80 : 0,
    networkScore: Math.min(100, i * 6 + 20),
  }));

  await db.insert(creditScoresTable).values(creditScores);

  const loanData = userIds.slice(0, 6).map((userId, i) => ({
    id: generateId(),
    userId,
    walletId: walletIds[i],
    amount: ((i + 1) * 30000).toFixed(4),
    currency: "XOF",
    interestRate: "12.00",
    termDays: 30 + i * 10,
    status: (["pending", "approved", "disbursed", "repaid", "defaulted", "disbursed"] as const)[i],
    amountRepaid: i === 3 ? ((i + 1) * 30000).toFixed(4) : "0.0000",
    purpose: ["Business capital", "Medical expenses", "Education", "Home improvement", "Agricultural", "Trade finance"][i],
    dueDate: new Date(now.getTime() + (30 + i * 10) * 24 * 60 * 60 * 1000),
    disbursedAt: i >= 2 ? new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000) : null,
  }));

  await db.insert(loansTable).values(loanData);

  const merchantWalletId = generateId();
  await db.insert(walletsTable).values({
    id: merchantWalletId,
    userId: userIds[5],
    currency: "XOF",
    balance: "1250000.0000",
    availableBalance: "1250000.0000",
    status: "active",
    walletType: "merchant",
  });

  await db.insert(merchantsTable).values({
    id: generateId(),
    userId: userIds[5],
    businessName: "Marché Digital Abidjan",
    businessType: "E-commerce",
    status: "active",
    walletId: merchantWalletId,
    apiKey: generateApiKey(),
    country: "CI",
    totalRevenue: "1250000.0000",
    transactionCount: 87,
  });

  const merchantWalletId2 = generateId();
  await db.insert(walletsTable).values({
    id: merchantWalletId2,
    userId: userIds[8],
    currency: "XOF",
    balance: "430000.0000",
    availableBalance: "430000.0000",
    status: "active",
    walletType: "merchant",
  });

  await db.insert(merchantsTable).values({
    id: generateId(),
    userId: userIds[8],
    businessName: "TechPay Dakar",
    businessType: "Digital Services",
    status: "active",
    walletId: merchantWalletId2,
    apiKey: generateApiKey(),
    country: "SN",
    totalRevenue: "430000.0000",
    transactionCount: 34,
  });

  console.log("✅ Database seeded successfully with KOWRI sample data");
}
