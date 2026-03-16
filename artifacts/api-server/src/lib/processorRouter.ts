export interface Processor {
  id:            string;
  name:          string;
  regions:       string[];
  currencies:    string[];
  costBps:       number;
  settlementMs:  number;
  successRate:   number;
  maxAmount:     number;
  active:        boolean;
}

export interface RoutingDecision {
  processor:     Processor;
  strategy:      string;
  costBps:       number;
  settlementMs:  number;
  reason:        string;
  alternatives:  Processor[];
}

const PROCESSORS: Processor[] = [
  {
    id:           "interswitch-africa",
    name:         "Interswitch Africa",
    regions:      ["africa"],
    currencies:   ["NGN", "XOF", "XAF", "GHS", "KES"],
    costBps:      25,
    settlementMs: 3_600_000,
    successRate:  0.995,
    maxAmount:    50_000_000,
    active:       true,
  },
  {
    id:           "flutterwave",
    name:         "Flutterwave",
    regions:      ["africa", "europe"],
    currencies:   ["USD", "EUR", "GBP", "XOF", "XAF", "GHS", "NGN"],
    costBps:      30,
    settlementMs: 7_200_000,
    successRate:  0.993,
    maxAmount:    100_000_000,
    active:       true,
  },
  {
    id:           "swift-europe",
    name:         "SWIFT Europe",
    regions:      ["europe", "global"],
    currencies:   ["USD", "EUR", "GBP", "CHF", "JPY"],
    costBps:      15,
    settlementMs: 86_400_000,
    successRate:  0.999,
    maxAmount:    1_000_000_000,
    active:       true,
  },
  {
    id:           "wise-global",
    name:         "Wise Global",
    regions:      ["europe", "asia", "africa"],
    currencies:   ["USD", "EUR", "GBP", "INR", "XOF"],
    costBps:      40,
    settlementMs: 1_800_000,
    successRate:  0.997,
    maxAmount:    200_000_000,
    active:       true,
  },
  {
    id:           "stripe-connect",
    name:         "Stripe Connect",
    regions:      ["europe", "asia", "africa"],
    currencies:   ["USD", "EUR", "GBP"],
    costBps:      29,
    settlementMs: 86_400_000,
    successRate:  0.998,
    maxAmount:    500_000_000,
    active:       true,
  },
  {
    id:           "asia-pay-hub",
    name:         "AsiaPay Hub",
    regions:      ["asia"],
    currencies:   ["USD", "CNY", "JPY", "SGD", "INR"],
    costBps:      20,
    settlementMs: 3_600_000,
    successRate:  0.994,
    maxAmount:    300_000_000,
    active:       true,
  },
];

function eligibleProcessors(opts: {
  currency?:  string;
  region?:    string;
  amount?:    number;
}): Processor[] {
  return PROCESSORS.filter(p => {
    if (!p.active) return false;
    if (opts.currency && !p.currencies.includes(opts.currency)) return false;
    if (opts.region   && !p.regions.includes(opts.region) && !p.regions.includes("global")) return false;
    if (opts.amount   && opts.amount > p.maxAmount) return false;
    return true;
  });
}

export function selectLowestCost(opts: { currency?: string; region?: string; amount?: number }): RoutingDecision | null {
  const eligible = eligibleProcessors(opts);
  if (!eligible.length) return null;
  const sorted = [...eligible].sort((a, b) => a.costBps - b.costBps);
  const best   = sorted[0];
  return {
    processor:    best,
    strategy:     "lowest_cost",
    costBps:      best.costBps,
    settlementMs: best.settlementMs,
    reason:       `Lowest cost processor at ${best.costBps}bps`,
    alternatives: sorted.slice(1, 3),
  };
}

export function selectFastest(opts: { currency?: string; region?: string; amount?: number }): RoutingDecision | null {
  const eligible = eligibleProcessors(opts);
  if (!eligible.length) return null;
  const sorted = [...eligible].sort((a, b) => a.settlementMs - b.settlementMs);
  const best   = sorted[0];
  return {
    processor:    best,
    strategy:     "fastest_settlement",
    costBps:      best.costBps,
    settlementMs: best.settlementMs,
    reason:       `Fastest settlement at ${(best.settlementMs / 3600000).toFixed(1)}h`,
    alternatives: sorted.slice(1, 3),
  };
}

export function selectRegional(region: string, opts: { currency?: string; amount?: number }): RoutingDecision | null {
  const eligible = eligibleProcessors({ ...opts, region });
  if (!eligible.length) return null;
  const sorted = [...eligible].sort((a, b) => b.successRate - a.successRate);
  const best   = sorted[0];
  return {
    processor:    best,
    strategy:     "regional_partner",
    costBps:      best.costBps,
    settlementMs: best.settlementMs,
    reason:       `Best regional partner for ${region} (${(best.successRate * 100).toFixed(1)}% success)`,
    alternatives: sorted.slice(1, 3),
  };
}

export function selectOptimal(opts: {
  strategy?:  "lowest_cost" | "fastest_settlement" | "regional_partner";
  currency?:  string;
  region?:    string;
  amount?:    number;
}): RoutingDecision | null {
  const { strategy = "lowest_cost", region = "africa", ...rest } = opts;
  if (strategy === "fastest_settlement") return selectFastest({ region, ...rest });
  if (strategy === "regional_partner")  return selectRegional(region, rest);
  return selectLowestCost({ region, ...rest });
}

export function getAllProcessors() { return PROCESSORS; }
