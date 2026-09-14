export const inboxViews = ["active", "all", "mine", "unassigned", "unread", "escalated", "dispo", "needs_outcome", "unknown", "dismissed"] as const;
export type InboxFilter = { view: typeof inboxViews[number]; hide_noise?: boolean; search?: string };
/** SQL owns normalization and matching semantics, including short search and unknown groups. */
export function parseInboxFilter(value: unknown): InboxFilter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const filter = value as Record<string, unknown>;
  if (Object.keys(filter).some(key => !["view", "hide_noise", "search"].includes(key))) return null;
  if (typeof filter.view !== "string" || !(inboxViews as readonly string[]).includes(filter.view)) return null;
  if (Object.hasOwn(filter, "hide_noise") && typeof filter.hide_noise !== "boolean") return null;
  if (Object.hasOwn(filter, "search") && typeof filter.search !== "string") return null;
  return { view: filter.view as InboxFilter["view"], ...(typeof filter.hide_noise === "boolean" ? { hide_noise: filter.hide_noise } : {}), ...(typeof filter.search === "string" ? { search: filter.search } : {}) };
}
export const inboxCountNames = ["all", "mine", "unassigned", "unread", "escalated", "dispo", "needs_outcome", "unknown", "dismissed"] as const;
export type InboxCounts = { counts: Record<typeof inboxCountNames[number], number>; asOf: string; accessEpoch: string };
