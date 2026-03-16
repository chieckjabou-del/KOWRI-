const RING_SIZE = 1000;

interface RingBuffer {
  data: number[];
  head: number;
  size: number;
}

function makeRing(): RingBuffer {
  return { data: [], head: 0, size: 0 };
}

function pushRing(ring: RingBuffer, value: number): void {
  ring.data[ring.head] = value;
  ring.head = (ring.head + 1) % RING_SIZE;
  if (ring.size < RING_SIZE) ring.size++;
}

function statsRing(ring: RingBuffer): { avg: number; p95: number; p99: number; count: number } {
  if (ring.size === 0) return { avg: 0, p95: 0, p99: 0, count: 0 };
  const sorted = ring.data.slice(0, ring.size).sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1];
  return { avg: Math.round(avg * 10) / 10, p95, p99, count: ring.size };
}

const store = {
  startTime: new Date(),
  transactionTotal: 0,
  transactionByType: {} as Record<string, number>,
  transactionLatencies: makeRing(),
  ledgerWriteLatencies: makeRing(),
  eventLatencies: makeRing(),
  eventTotal: 0,
  eventByType: {} as Record<string, number>,
  errors: 0,
};

export function recordMetric(
  category: "transaction" | "ledger" | "event",
  latencyMs: number,
  subType?: string
): void {
  switch (category) {
    case "transaction":
      store.transactionTotal++;
      if (subType) store.transactionByType[subType] = (store.transactionByType[subType] ?? 0) + 1;
      pushRing(store.transactionLatencies, latencyMs);
      break;
    case "ledger":
      pushRing(store.ledgerWriteLatencies, latencyMs);
      break;
    case "event":
      store.eventTotal++;
      if (subType) store.eventByType[subType] = (store.eventByType[subType] ?? 0) + 1;
      pushRing(store.eventLatencies, latencyMs);
      break;
  }
}

export function recordError(): void {
  store.errors++;
}

export function getMetrics() {
  const uptimeSec = Math.floor((Date.now() - store.startTime.getTime()) / 1000);
  return {
    system: {
      startTime: store.startTime.toISOString(),
      uptimeSeconds: uptimeSec,
      nodeVersion: process.version,
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
    transactions: {
      total: store.transactionTotal,
      byType: store.transactionByType,
      latency: statsRing(store.transactionLatencies),
    },
    ledger: {
      writes: store.ledgerWriteLatencies.size,
      latency: statsRing(store.ledgerWriteLatencies),
    },
    events: {
      total: store.eventTotal,
      byType: store.eventByType,
      latency: statsRing(store.eventLatencies),
    },
    errors: {
      total: store.errors,
    },
  };
}
