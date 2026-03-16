export type TxStatus = "pending" | "processing" | "completed" | "failed" | "reversed";

const ALLOWED_TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  pending:    ["processing", "failed"],
  processing: ["completed", "failed"],
  completed:  ["reversed"],
  failed:     [],
  reversed:   [],
};

export class InvalidTransitionError extends Error {
  constructor(from: TxStatus, to: TxStatus) {
    super(`Invalid transaction state transition: ${from} → ${to}. Allowed from ${from}: [${ALLOWED_TRANSITIONS[from].join(", ") || "none"}]`);
    this.name = "InvalidTransitionError";
  }
}

export function assertValidTransition(from: TxStatus, to: TxStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function canTransition(from: TxStatus, to: TxStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function getAllowedTransitions(from: TxStatus): TxStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export const STATE_MACHINE_DIAGRAM = {
  states: Object.keys(ALLOWED_TRANSITIONS),
  transitions: Object.entries(ALLOWED_TRANSITIONS).flatMap(([from, tos]) =>
    tos.map((to) => ({ from, to }))
  ),
};
