import { savePostCallExtras } from "../actions"
import { clearExtras } from "./extras-store"
import type { PostCallExtras, PostCallExtrasResult } from "./types"

export type ExtrasRequest = {
  attemptKey: string
  memberId: string
  propertyId: string
  extras: PostCallExtras
}

/** True only when the server confirmed both extras (nothing failed, no message). */
export function extrasConfirmed(result: PostCallExtrasResult): boolean {
  return result.ok && result.note !== "failed" && result.nextStep !== "failed" && !result.message
}

/**
 * The one saver of a saved attempt's note and quick next step (P1c). Every recovery path may call
 * it again for the same attempt: the server writes only after proving the attempt, with keys derived from it, so a
 * repeat cannot duplicate. The stored entry is removed only after the server confirms both extras; a failure
 * keeps it for a retry. Returns null (and does nothing) when this submission is already in flight.
 * `onStart` runs once the request is claimed, before the write.
 */
export async function saveExtrasRequest(
  request: ExtrasRequest,
  viewerUserId: string,
  inFlight: Set<string>,
  onStart?: () => void,
): Promise<PostCallExtrasResult | null> {
  const { extras } = request
  if (inFlight.has(extras.submissionId)) return null
  inFlight.add(extras.submissionId)
  onStart?.()
  let result: PostCallExtrasResult
  try {
    result = await savePostCallExtras({
      memberId: request.memberId,
      propertyId: request.propertyId,
      submissionId: extras.submissionId,
      attemptKey: request.attemptKey,
      callActivityId: extras.callActivityId ?? null,
      note: extras.note,
      nextStep: extras.nextStep,
    })
  } catch {
    result = { ok: false, message: "The note and next step could not be saved." }
  } finally {
    inFlight.delete(extras.submissionId)
  }
  // Done with: both extras written, or another prompt already saved this call (never retry those).
  if (extrasConfirmed(result) || (!result.ok && result.alreadySaved)) clearExtras(viewerUserId, request.attemptKey)
  return result
}
