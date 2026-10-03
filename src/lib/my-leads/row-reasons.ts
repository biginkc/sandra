import type { MyLeadRowReason } from "./queries"

/** Plain-English UI copy for why a linked lead is not in a My Leads queue. */
export const MY_LEAD_ROW_REASON_COPY: Record<MyLeadRowReason, string> = {
  not_found: "We couldn't find this lead.",
  unassigned: "This lead isn't assigned to anyone yet.",
  other_rep: "This lead is assigned to another rep.",
  closed_dead_dnc: "This lead is closed, dead or marked do-not-contact.",
  archived: "This lead was archived from My Leads.",
  no_active_episode: "This lead isn't in an active My Leads queue right now.",
}

export const MY_LEAD_ROW_FORBIDDEN_COPY = "You don't have access to this lead in My Leads."
export const MY_LEAD_ROW_ERROR_COPY = "We couldn't check this lead right now. Try opening it again."
