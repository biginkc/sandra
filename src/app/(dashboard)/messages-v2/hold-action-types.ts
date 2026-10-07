import type { TeamMember } from "@/lib/auth/team-member";
import type { Result } from "@/lib/errors/result";

/**
 * The server actions the holds rail calls. The server page passes the real
 * ones (server actions are serializable props); tests pass fakes. Keeping the
 * contract here keeps client components free of server-only imports.
 */
export type HoldActionsApi = {
  send(input: { draftId: string }): Promise<Result<{ messageId: string }>>;
  editAndSend(input: { draftId: string; body: string }): Promise<Result<{ messageId: string }>>;
  takeOver(input: { propertyId: string }): Promise<Result<{ leadHref: string }>>;
  assign(input: { propertyId: string; assigneeId: string | null }): Promise<Result<null>>;
  dismiss(input: { propertyId: string; reason: string }): Promise<Result<null>>;
  listAssignees(input: { propertyId: string }): Promise<Result<TeamMember[]>>;
};
