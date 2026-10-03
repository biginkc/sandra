import type { MyLeadRowReason, QueueRow } from "@/lib/my-leads/queries";

/**
 * A lead link is an address for a lead, never an authorization grant. Keep the
 * parser deliberately small and strict so a malformed or repeated parameter
 * cannot accidentally select a different value.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MyLeadsSearchParams = Record<string, string | string[] | undefined>;

export type SelectedLeadLink =
  | { status: "none" }
  | { status: "invalid"; reason: "malformed" | "duplicate" }
  | { status: "requested"; propertyId: string };

export type SelectedLeadResult =
  | { status: "none" }
  | { status: "invalid"; reason: "malformed" | "duplicate" }
  | { status: "unavailable"; message: string }
  | { status: "found"; propertyId: string; row: QueueRow; snapshotAt: string };

export function parseSelectedLeadParam(
  params: MyLeadsSearchParams | null | undefined,
): SelectedLeadLink {
  const value = params?.lead;
  if (value === undefined) return { status: "none" };
  if (Array.isArray(value)) return { status: "invalid", reason: "duplicate" };
  if (!UUID.test(value)) return { status: "invalid", reason: "malformed" };
  return { status: "requested", propertyId: value.toLowerCase() };
}

export function selectedLeadUnavailableMessage(reason: MyLeadRowReason | "access_denied"): string {
  switch (reason) {
    case "other_rep":
      return "This lead is assigned to another representative. My Leads will not switch queues from a link.";
    case "unassigned":
      return "This lead is not assigned to your My Leads queue.";
    case "closed_dead_dnc":
      return "This lead is closed or DNC-locked and is unavailable in My Leads.";
    case "archived":
      return "This lead is archived and is unavailable in My Leads.";
    case "no_active_episode":
      return "This lead no longer has an active My Leads assignment.";
    case "not_found":
    case "access_denied":
      return "This lead is unavailable in your My Leads queue.";
  }
}
