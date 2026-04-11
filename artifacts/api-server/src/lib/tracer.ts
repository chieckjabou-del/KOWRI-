import { db } from "@workspace/db";
import { serviceTracesTable } from "@workspace/db";
import { generateId } from "./id";

interface SpanContext {
  traceId:  string;
  spanId:   string;
  service:  string;
  operation: string;
  startMs:  number;
  parentSpanId?: string;
  metadata?: Record<string, unknown>;
}

interface CallGraphEdge {
  from: string;
  to: string;
  op: string;
  durationMs: number;
}

class DistributedTracer {
  private activeSpans = new Map<string, SpanContext>();
  private callGraph: CallGraphEdge[] = [];

  startSpan(service: string, operation: string, traceId?: string, parentSpanId?: string): SpanContext {
    const ctx: SpanContext = {
      traceId:     traceId ?? generateId(),
      spanId:      generateId(),
      service,
      operation,
      startMs:     Date.now(),
      parentSpanId,
    };
    this.activeSpans.set(ctx.spanId, ctx);
    return ctx;
  }

  async finishSpan(ctx: SpanContext, status: "ok" | "error" = "ok", metadata?: Record<string, unknown>): Promise<void> {
    const durationMs = Date.now() - ctx.startMs;
    this.activeSpans.delete(ctx.spanId);

    if (ctx.parentSpanId) {
      const parent = [...this.activeSpans.values()].find((s) => s.spanId === ctx.parentSpanId);
      if (parent) {
        this.callGraph.push({
          from: parent.service,
          to:   ctx.service,
          op:   ctx.operation,
          durationMs,
        });
      }
    }

    try {
      await db.insert(serviceTracesTable).values({
        id:          generateId(),
        traceId:     ctx.traceId,
        spanId:      ctx.spanId,
        parentSpanId: ctx.parentSpanId,
        service:     ctx.service,
        operation:   ctx.operation,
        durationMs,
        status,
        metadata:    (metadata ?? ctx.metadata ?? {}) as any,
        startedAt:   new Date(ctx.startMs),
      });
    } catch (err) {
      console.error("[Tracer] Failed to persist span:", err);
    }
  }

  async trace<T>(
    service: string,
    operation: string,
    fn: (ctx: SpanContext) => Promise<T>,
    parentCtx?: SpanContext,
  ): Promise<T> {
    const ctx = this.startSpan(service, operation, parentCtx?.traceId, parentCtx?.spanId);
    try {
      const result = await fn(ctx);
      await this.finishSpan(ctx, "ok");
      return result;
    } catch (err) {
      await this.finishSpan(ctx, "error", { error: String(err) });
      throw err;
    }
  }

  async getCallGraph(traceId?: string): Promise<{
    services: string[];
    spans: Array<Record<string, unknown>>;
    callGraph: CallGraphEdge[];
    latency: Record<string, number>;
  }> {
    const query = db.select().from(serviceTracesTable).limit(500);
    const rows = await query;

    const filtered = traceId ? rows.filter((r) => r.traceId === traceId) : rows;

    const services = [...new Set(filtered.map((r) => r.service))];
    const latency: Record<string, number> = {};
    for (const svc of services) {
      const svcSpans = filtered.filter((r) => r.service === svc && r.durationMs !== null);
      if (svcSpans.length > 0) {
        latency[svc] = Math.round(svcSpans.reduce((s, r) => s + (r.durationMs ?? 0), 0) / svcSpans.length);
      }
    }

    return {
      services,
      spans: filtered.slice(0, 100).map((r) => ({
        traceId:  r.traceId,
        spanId:   r.spanId,
        parentSpanId: r.parentSpanId,
        service:  r.service,
        operation: r.operation,
        durationMs: r.durationMs,
        status:   r.status,
        startedAt: r.startedAt,
      })),
      callGraph: this.callGraph.slice(-50),
      latency,
    };
  }
}

export const tracer = new DistributedTracer();
