import type { TeamMember } from "@/lib/auth/team-member";
import type { Result } from "@/lib/errors/result";

import type { HoldSeen } from "./types";

/** The draft as the clicker saw it: the exact text (edit included) and its edit version. */
export type SeenDraft = { body: string; editedAt: string | null };

/**
 * The server actions the holds rail calls. The server page passes the real
 * ones (server actions are serializable props); tests pass fakes. Keeping the
 * contract here keeps client components free of server-only imports.
 */
export type HoldActionsApi = {
  send(input: { draftId: string; seen: SeenDraft }): Promise<Result<{ messageId: string }>>;
  editAndSend(input: { draftId: string; body: string; seen: SeenDraft }): Promise<Result<{ messageId: string }>>;
  takeOver(input: { propertyId: string; seen: HoldSeen }): Promise<Result<{ leadHref: string }>>;
  assign(input: { propertyId: string; assigneeId: string | null }): Promise<Result<null>>;
  dismiss(input: { propertyId: string; reason: string; seen: HoldSeen }): Promise<Result<null>>;
  /** Optional: re-run suppression for a `suppression_incomplete` hold (the lead banner's action). */
  retrySuppression?(input: { propertyId: string }): Promise<Result<{ cleared: boolean; remaining: number }>>;
  /** Optional: apply Luna's pending suggestion (never offered for opt-out outcomes). */
  lunaApply?(input: { suggestionId: string }): Promise<Result<{ status: string; resolvedOutcome: string; warning?: string }>>;
  /** Optional: dismiss Luna's pending suggestion. */
  lunaReject?(input: { suggestionId: string }): Promise<Result<null>>;
  listAssignees(input: { propertyId: string }): Promise<Result<TeamMember[]>>;
};
