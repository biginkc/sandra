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
  /** propertyId = the card the clicker saw; the server refuses (HOLD_STALE) if the draft no longer resolves to it. */
  send(input: { draftId: string; seen: SeenDraft; propertyId: string }): Promise<Result<{ messageId: string }>>;
  editAndSend(input: { draftId: string; body: string; seen: SeenDraft; propertyId: string }): Promise<Result<{ messageId: string }>>;
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

/** Current card details for some snapshot ids ("Show older"). */
export type OlderHoldsPage = {
  holds: OpenHold<RunWithSteps>[];
  labels: Array<[string, RunLabel]>;
  /** Requested ids no longer waiting (resolved, locked or unverifiable since the snapshot). */
  missing: string[];
  /** Hidden because they could not be tied to exactly one property. */
  unverified: number | null;
  /** Card annotations that failed for this page (amber note). */
  contextErrors: string[];
};

/** Server action behind "Show older": the next snapshot ids (at most 100). */
export type LoadOlderHolds = (input: { ids: string[] }) => Promise<Result<OlderHoldsPage>>;

export type { WaitingSnapshot, SnapshotEntry, HoldLiveState } from "./hold-list";

/** Server action behind the waiting column's 60-second / tab-focus re-check (at most 100 ids per call). */
export type RevalidateHolds = (input: { ids: string[] }) => Promise<Result<import("./hold-list").HoldLiveState[]>>;

/** Server action behind the Backlog disclosure ("Load more" passes the next offset). */
export type LoadBacklog = (input: {
  offset: number;
  limit?: number;
  bucket?: "new" | "backlog";
}) => Promise<Result<BacklogPage>>;
