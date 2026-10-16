import { reportError } from "@/lib/errors/report";

import type { DispatchResult } from "./dispatch";
import type { NormaCompleteResult } from "./types";

/**
 * Call twice. `fn_norma_complete_call` schedules the retry in SQL (exactly once,
 * under the request's row lock) and tells the caller by returning
 * `applied` + `retry: true`. This runs the ordinary `dispatchNormaCall` for it,
 * so the dispatch gate and the dial-time eligibility recheck apply again.
 *
 * Never throws. If the dispatch cannot run (process dies, Bland down) the
 * request is simply left `requested` with attempt 2 and the reconciliation
 * sweep dispatches it; calling this twice is harmless because the dispatch
 * claim is atomic and a replayed completion never reports `retry` again.
 */
export async function dispatchScheduledRetry(
  result: NormaCompleteResult,
  requestId: string,
  dispatch: ((requestId: string) => Promise<DispatchResult>) | undefined,
): Promise<DispatchResult | null> {
  if (!dispatch || result.result !== "applied" || result.retry !== true) return null;
  try {
    return await dispatch(requestId);
  } catch (error) {
    reportError(error, { tags: { surface: "norma_retry_dispatch" }, extra: { requestId } });
    return null;
  }
}
