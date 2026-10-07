import { AsyncLocalStorage } from "node:async_hooks";

import type { MaybeRunContext, PipelineRunContext } from "./types";

/**
 * Ambient run context for one dispatch call. dispatch.ts has dozens of small
 * helpers (markPropertyNeedsAttention, sendResponderMessage, ...) that every
 * terminal branch funnels through; threading an explicit ctx through each
 * would change ~40 call sites. The ambient context lets those helpers record
 * evidence without any signature or ordering change. Outside a run it is
 * null and every recorder is a no-op.
 */
const storage = new AsyncLocalStorage<PipelineRunContext | null>();

export function runWithPipelineRun<T>(
  ctx: MaybeRunContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx ?? null, fn);
}

export function currentPipelineRun(): PipelineRunContext | null {
  return storage.getStore() ?? null;
}
