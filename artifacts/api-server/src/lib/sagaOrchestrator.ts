import { db } from "@workspace/db";
import { sagasTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generateId } from "./id";
import { audit as auditLog } from "./auditLogger";

export interface SagaStep<TCtx extends Record<string, unknown>> {
  name: string;
  execute: (ctx: TCtx) => Promise<TCtx>;
  compensate?: (ctx: TCtx) => Promise<void>;
}

export type SagaStatus = "started" | "in_progress" | "completed" | "failed" | "compensated";

async function persistSaga(
  id: string,
  status: SagaStatus,
  currentStep: number,
  context: Record<string, unknown>,
  error?: string
): Promise<void> {
  await db
    .update(sagasTable)
    .set({ status, currentStep, context: context as any, error: error ?? null, updatedAt: new Date() })
    .where(eq(sagasTable.id, id));
}

export class SagaOrchestrator {
  async execute<TCtx extends Record<string, unknown>>(
    sagaType: string,
    initialContext: TCtx,
    steps: SagaStep<TCtx>[]
  ): Promise<TCtx> {
    const sagaId = generateId();
    const completedSteps: Array<{ step: SagaStep<TCtx>; ctx: TCtx }> = [];

    await db.insert(sagasTable).values({
      id: sagaId,
      sagaType,
      status: "started",
      steps: steps.map((s) => s.name) as any,
      context: initialContext as any,
      currentStep: 0,
    });

    await auditLog({
      action: "saga.started",
      entity: "saga",
      entityId: sagaId,
      metadata: { sagaType, steps: steps.map((s) => s.name) },
    });

    let ctx = initialContext;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      await persistSaga(sagaId, "in_progress", i, ctx as Record<string, unknown>);

      try {
        ctx = await step.execute(ctx);
        completedSteps.push({ step, ctx });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Saga:${sagaType}] Step '${step.name}' failed:`, errMsg);

        await persistSaga(sagaId, "failed", i, ctx as Record<string, unknown>, errMsg);
        await auditLog({ action: "saga.step.failed", entity: "saga", entityId: sagaId, metadata: { step: step.name, error: errMsg } });

        await this.compensate(sagaId, sagaType, completedSteps, ctx);
        throw new Error(`Saga '${sagaType}' failed at step '${step.name}': ${errMsg}`);
      }
    }

    await persistSaga(sagaId, "completed", steps.length, ctx as Record<string, unknown>);
    await auditLog({ action: "saga.completed", entity: "saga", entityId: sagaId, metadata: { sagaType } });

    return ctx;
  }

  private async compensate<TCtx extends Record<string, unknown>>(
    sagaId: string,
    sagaType: string,
    completedSteps: Array<{ step: SagaStep<TCtx>; ctx: TCtx }>,
    lastCtx: TCtx
  ): Promise<void> {
    const toCompensate = [...completedSteps].reverse();
    for (const { step, ctx } of toCompensate) {
      if (!step.compensate) continue;
      try {
        await step.compensate(ctx);
        console.log(`[Saga:${sagaType}] Compensated step '${step.name}'`);
      } catch (err: unknown) {
        console.error(`[Saga:${sagaType}] Compensation failed for '${step.name}':`, err);
      }
    }
    await persistSaga(sagaId, "compensated", 0, lastCtx as Record<string, unknown>);
    await auditLog({ action: "saga.compensated", entity: "saga", entityId: sagaId, metadata: { sagaType } });
  }
}

export const sagaOrchestrator = new SagaOrchestrator();
