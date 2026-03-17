import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

type CBState = "closed" | "open" | "half-open";

interface CircuitBreakerConfig {
  failureThreshold:  number;
  successThreshold:  number;
  halfOpenTimeoutMs: number;
  name:              string;
}

class CircuitBreaker {
  private state: CBState = "closed";
  private failures  = 0;
  private successes = 0;
  private lastOpenedAt: number | null = null;
  private cfg: CircuitBreakerConfig;

  constructor(cfg: CircuitBreakerConfig) {
    this.cfg = cfg;
  }

  get isOpen()     { return this.state === "open"; }
  get isClosed()   { return this.state === "closed"; }
  get isHalfOpen() { return this.state === "half-open"; }
  get status()     { return this.state; }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const elapsed = Date.now() - (this.lastOpenedAt ?? 0);
      if (elapsed >= this.cfg.halfOpenTimeoutMs) {
        this.state = "half-open";
        this.successes = 0;
      } else {
        throw new CircuitOpenError(this.cfg.name, elapsed, this.cfg.halfOpenTimeoutMs);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === "half-open") {
      this.successes++;
      if (this.successes >= this.cfg.successThreshold) {
        this.state = "closed";
        console.info(`[CircuitBreaker:${this.cfg.name}] Closed after recovery`);
      }
    }
  }

  private onFailure(err: unknown): void {
    this.failures++;
    if (this.failures >= this.cfg.failureThreshold && this.state !== "open") {
      this.state = "open";
      this.lastOpenedAt = Date.now();
      console.error(`[CircuitBreaker:${this.cfg.name}] OPENED after ${this.failures} failures`, err);
    }
  }

  reset(): void {
    this.state     = "closed";
    this.failures  = 0;
    this.successes = 0;
    this.lastOpenedAt = null;
  }

  getStats() {
    return {
      name:           this.cfg.name,
      state:          this.state,
      failures:       this.failures,
      successes:      this.successes,
      lastOpenedAt:   this.lastOpenedAt,
      halfOpenTimeoutMs: this.cfg.halfOpenTimeoutMs,
    };
  }
}

export class CircuitOpenError extends Error {
  constructor(name: string, elapsedMs: number, timeoutMs: number) {
    super(`Circuit breaker '${name}' is OPEN. Retry in ${Math.ceil((timeoutMs - elapsedMs) / 1000)}s`);
    this.name = "CircuitOpenError";
  }
}

export const dbCircuitBreaker = new CircuitBreaker({
  name:              "database",
  failureThreshold:  5,
  successThreshold:  2,
  halfOpenTimeoutMs: 10_000,
});

export const eventBusCircuitBreaker = new CircuitBreaker({
  name:              "event-bus-db",
  failureThreshold:  3,
  successThreshold:  1,
  halfOpenTimeoutMs: 5_000,
});

export const webhookCircuitBreaker = new CircuitBreaker({
  name:              "webhooks",
  failureThreshold:  10,
  successThreshold:  3,
  halfOpenTimeoutMs: 30_000,
});

export async function checkDbHealth(): Promise<{ healthy: boolean; state: string; latencyMs: number }> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    if (dbCircuitBreaker.isOpen || dbCircuitBreaker.isHalfOpen) {
      dbCircuitBreaker.reset();
    }
    return { healthy: true, state: dbCircuitBreaker.status, latencyMs: Date.now() - start };
  } catch {
    return { healthy: false, state: dbCircuitBreaker.status, latencyMs: Date.now() - start };
  }
}

export function getAllBreakerStats() {
  return [
    dbCircuitBreaker.getStats(),
    eventBusCircuitBreaker.getStats(),
    webhookCircuitBreaker.getStats(),
  ];
}
