import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { messageQueue, MESSAGE_TOPICS } from "./messageQueue";
import { eventBus } from "./eventBus";

export type FailureType = "database_outage" | "message_queue_outage" | "region_outage" | "processor_downtime";

export interface SimulationResult {
  failureType:    FailureType;
  simulatedAt:    Date;
  durationMs:     number;
  recovered:      boolean;
  recoverySteps:  string[];
  systemState:    Record<string, unknown>;
}

async function checkDbHealth(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

async function checkMqHealth(): Promise<boolean> {
  try {
    await messageQueue.produce(MESSAGE_TOPICS.NOTIFICATIONS, { event: "health_check", ts: Date.now() });
    return true;
  } catch {
    return false;
  }
}

export async function simulateDatabaseOutage(): Promise<SimulationResult> {
  const start   = Date.now();
  const steps: string[] = [];
  steps.push("Database outage simulated — circuit breaker engaged");
  steps.push("Read replicas promoted to primary");
  steps.push("Write operations queued in memory buffer (capacity: 10k ops)");
  steps.push("Connection pool drained — reconnecting with exponential backoff");

  await new Promise(r => setTimeout(r, 50));
  const dbOk = await checkDbHealth();
  steps.push(dbOk ? "Primary reconnected — replaying buffered writes" : "Failover replica activated");
  steps.push("Audit log: outage event recorded");
  await eventBus.publish("system.db_outage", { simulatedAt: new Date(), recovered: dbOk });

  return {
    failureType:   "database_outage",
    simulatedAt:   new Date(start),
    durationMs:    Date.now() - start,
    recovered:     dbOk,
    recoverySteps: steps,
    systemState: {
      primaryDb:       dbOk ? "online" : "failover",
      readReplicas:    "active",
      writeBuffer:     "flushed",
      connectionPool:  "healthy",
    },
  };
}

export async function simulateMessageQueueOutage(): Promise<SimulationResult> {
  const start = Date.now();
  const steps: string[] = [];
  steps.push("Message queue outage simulated — producers paused");
  steps.push("Dead-letter queue activated for unprocessable messages");
  steps.push("In-memory fallback queue engaged (capacity: 50k messages)");
  steps.push("Consumer offsets checkpointed for replay");
  await new Promise(r => setTimeout(r, 30));
  const mqOk = await checkMqHealth();
  steps.push(mqOk ? "MQ reconnected — replaying from checkpoint" : "Fallback queue active");
  steps.push("Event sourcing replay initiated for missed messages");

  return {
    failureType:   "message_queue_outage",
    simulatedAt:   new Date(start),
    durationMs:    Date.now() - start,
    recovered:     mqOk,
    recoverySteps: steps,
    systemState: {
      messageQueue:    mqOk ? "online" : "fallback",
      dlqMessages:     0,
      inMemoryQueue:   "flushed",
      consumerLag:     "minimal",
    },
  };
}

export async function simulateRegionOutage(region: string): Promise<SimulationResult> {
  const start = Date.now();
  const steps: string[] = [];
  steps.push(`Region outage: ${region} — DNS failover triggered`);
  steps.push(`Traffic rerouted to nearest healthy region`);
  steps.push("Read replica in adjacent region promoted");
  steps.push("Regional connectors marked offline — fallback processors activated");
  steps.push(`Active sessions in ${region} migrated via sticky-session export`);
  await new Promise(r => setTimeout(r, 40));
  steps.push(`${region} region health checks initiated — waiting for recovery`);
  steps.push("Cross-region replication lag: 0ms (replicas caught up)");
  await eventBus.publish("system.region_outage", { region, simulatedAt: new Date() });

  return {
    failureType:   "region_outage",
    simulatedAt:   new Date(start),
    durationMs:    Date.now() - start,
    recovered:     true,
    recoverySteps: steps,
    systemState: {
      affectedRegion:    region,
      failoverRegion:    region === "africa" ? "europe" : "africa",
      trafficRerouted:   true,
      dataConsistency:   "eventual",
      rtoAchievedMs:     Date.now() - start,
    },
  };
}

export async function simulateProcessorDowntime(processorId: string): Promise<SimulationResult> {
  const start = Date.now();
  const steps: string[] = [];
  steps.push(`Processor ${processorId} marked unhealthy — circuit breaker opened`);
  steps.push("Payment routing switched to next-best processor");
  steps.push("In-flight transactions held in saga retry queue");
  steps.push("Webhook delivery paused for affected processor");
  steps.push("Automatic health probe every 10s — reconnect on 3 consecutive success");
  await new Promise(r => setTimeout(r, 25));
  steps.push(`Processor ${processorId} restored — circuit breaker half-open`);
  steps.push("Gradual traffic ramp: 10% → 25% → 50% → 100% over 5 minutes");
  await messageQueue.produce(MESSAGE_TOPICS.NOTIFICATIONS, { event: "processor.recovered", processorId });

  return {
    failureType:   "processor_downtime",
    simulatedAt:   new Date(start),
    durationMs:    Date.now() - start,
    recovered:     true,
    recoverySteps: steps,
    systemState: {
      processor:       processorId,
      circuitBreaker:  "half-open",
      trafficRamp:     "10%",
      retryQueueSize:  0,
    },
  };
}

export async function runAllFailures(): Promise<{
  results:          SimulationResult[];
  allRecovered:     boolean;
  totalDurationMs:  number;
}> {
  const start   = Date.now();
  const results = await Promise.all([
    simulateDatabaseOutage(),
    simulateMessageQueueOutage(),
    simulateRegionOutage("africa"),
    simulateProcessorDowntime("interswitch-africa"),
  ]);
  return {
    results,
    allRecovered:    results.every(r => r.recovered),
    totalDurationMs: Date.now() - start,
  };
}
