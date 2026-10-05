import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { markNormaReviewed } from "./rpc";

type Client = SupabaseClient<Database>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ok` is true when the request is now (or already was) reviewed. A double
 * click is `already_reviewed`, still a success. Every other code leaves the
 * request exactly as it was.
 */
export type MarkNormaReviewedResult =
  | { ok: true; code: "reviewed" | "already_reviewed" }
  | { ok: false; code: "unauthenticated" | "not_found" | "not_authorized" | "error" }
  /** The call is not waiting for review any more (a late result completed it, or it never needed review). */
  | { ok: false; code: "not_waiting"; status: string };

export type MarkNormaReviewedDeps = {
  /** Session-authenticated user id, or null when signed out. */
  getUserId: () => Promise<string | null>;
  /** Service-role client: the RPC is service-role only and checks membership itself. */
  adminClient: Client;
};

/**
 * "Mark reviewed" for a Norma call stuck in needs_review. The user comes from
 * the session, never from the caller's arguments; every other rule (active
 * membership of the lead's org, the right status, the lock order, the task and
 * drip handling) is enforced in SQL.
 */
export async function markNormaReviewedCore(
  propertyId: string,
  requestId: string,
  deps: MarkNormaReviewedDeps,
): Promise<MarkNormaReviewedResult> {
  if (!UUID_PATTERN.test(propertyId) || !UUID_PATTERN.test(requestId)) return { ok: false, code: "not_found" };
  const userId = await deps.getUserId();
  if (!userId) return { ok: false, code: "unauthenticated" };

  let answer;
  try {
    answer = await markNormaReviewed(deps.adminClient, { requestId, propertyId, userId });
  } catch {
    return { ok: false, code: "error" };
  }
  switch (answer.result) {
    case "reviewed":
    case "already_reviewed":
      return { ok: true, code: answer.result };
    case "invalid_state":
      return { ok: false, code: "not_waiting", status: answer.status };
    default:
      return { ok: false, code: answer.result };
  }
}

/** Plain wording for the toast / notice; no seller-facing text. */
export function markReviewedText(result: MarkNormaReviewedResult): { tone: "success" | "error"; text: string } {
  if (result.ok) return { tone: "success", text: result.code === "reviewed" ? "Marked as reviewed." : "Already marked as reviewed." };
  switch (result.code) {
    case "not_waiting":
      return { tone: "error", text: "This call is no longer waiting for review. Reload the page." };
    case "unauthenticated":
      return { tone: "error", text: "Sign in again to mark this reviewed." };
    case "not_authorized":
      return { tone: "error", text: "Only active workspace members can mark this reviewed." };
    case "not_found":
      return { tone: "error", text: "This call could not be found. Reload the page." };
    default:
      return { tone: "error", text: "Could not mark this reviewed. Nothing was changed. Try again." };
  }
}
