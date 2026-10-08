import type { TeamMember } from "@/lib/auth/team-member";
import type { Result } from "@/lib/errors/result";

import type { HoldSeen, OpenHold, RunLabel, RunWithSteps } from "./types";

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
  listAssignees(input: { propertyId: string }): Promise<Result<TeamMember[]>>;
};

/** One page of Backlog holds for the collapsed rail section. */
export type BacklogPage = {
  holds: OpenHold<RunWithSteps>[];
  labels: Array<[string, RunLabel]>;
  backlogTotal: number;
  hasMore: boolean;
  /** Offset to request next: counts property ids consumed, not cards rendered. */
  nextOffset: number;
};

/** Server action behind the Backlog disclosure ("Load more" passes the next offset). */
export type LoadBacklog = (input: {
  offset: number;
  limit?: number;
}) => Promise<Result<BacklogPage>>;
