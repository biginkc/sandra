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
  /** Hostile hold only: send the approved hostile reply (if any), then suppress the number. */
  confirmDoNotContact?(input: {
    propertyId: string;
    seen: HoldSeen;
  }): Promise<Result<{ replySent: boolean; replyNote: string | null }>>;
  /** Optional: re-run suppression for a `suppression_incomplete` hold (the lead banner's action). */
  retrySuppression?(input: { propertyId: string }): Promise<Result<{ cleared: boolean; remaining: number }>>;
  /** Optional: apply Luna's pending suggestion (never offered for opt-out outcomes). */
  lunaApply?(input: { suggestionId: string }): Promise<Result<{ status: string; resolvedOutcome: string; warning?: string }>>;
  /** Optional: dismiss Luna's pending suggestion. */
  lunaReject?(input: { suggestionId: string }): Promise<Result<null>>;
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

/** One slice of the waiting list in latest-activity order (DNC-locked already excluded). */
export type OlderHoldsPage = {
  holds: OpenHold<RunWithSteps>[];
  labels: Array<[string, RunLabel]>;
  /** Holds still to load after this page. */
  remaining: number;
  /** All eligible holds right now (locked and unverifiable excluded). */
  total: number;
  /** Hidden because they could not be tied to exactly one property. */
  unverified: number;
  /** Echo back for the next page; null = nothing more. Issued by the server, never built by the client. */
  nextCursor: { at: string | null; id: string; snapshotAt: string } | null;
  /** Card annotations that failed for this page (amber note). */
  contextErrors: string[];
};

/** Server action behind "Show older": the next keyset page after the last loaded hold. */
export type LoadOlderHolds = (input: {
  /** The cursor the server issued with the previous page (echoed verbatim). Holds strictly after it come back. */
  cursor: { at: string | null; id: string; snapshotAt: string } | null;
  limit?: number;
}) => Promise<Result<OlderHoldsPage>>;

/** Server action behind the Backlog disclosure ("Load more" passes the next offset). */
export type LoadBacklog = (input: {
  offset: number;
  limit?: number;
  bucket?: "new" | "backlog";
}) => Promise<Result<BacklogPage>>;
