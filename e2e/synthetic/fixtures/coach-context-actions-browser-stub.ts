import type { CoachCallContext } from "@/lib/coach/types";

export type SyntheticContextMode = "immediate" | "deferred" | "failure";

type PendingContextLoad = {
  resolve: (context: CoachCallContext) => void;
  reject: (error: Error) => void;
};

let mode: SyntheticContextMode = "immediate";
let context: CoachCallContext;
let failNext = false;
const pending: PendingContextLoad[] = [];

export function configureSyntheticCoachContext(
  nextMode: SyntheticContextMode,
  nextContext: CoachCallContext,
): void {
  mode = nextMode;
  context = nextContext;
  failNext = false;
  pending.splice(0);
}

export function setSyntheticCoachContextMode(nextMode: SyntheticContextMode): void {
  mode = nextMode;
}

export function failNextSyntheticCoachContextLoad(): void {
  failNext = true;
}

export function resolveSyntheticCoachContextLoads(): void {
  const loads = pending.splice(0);
  for (const load of loads) load.resolve(context);
}

export function rejectSyntheticCoachContextLoads(): void {
  const loads = pending.splice(0);
  for (const load of loads) load.reject(new Error("synthetic context failure"));
}

export async function loadCoachCallContext(): Promise<CoachCallContext> {
  if (failNext) {
    failNext = false;
    throw new Error("synthetic context failure");
  }
  if (mode === "failure") throw new Error("synthetic context failure");
  if (mode === "deferred") {
    return new Promise<CoachCallContext>((resolve, reject) => pending.push({ resolve, reject }));
  }
  return context;
}
