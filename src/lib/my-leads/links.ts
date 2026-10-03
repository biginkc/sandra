export type MyLeadsLinkAction = "log-attempt";

/** Deep link that opens one lead's details on My Leads, optionally straight into an action. */
export function myLeadsHref(propertyId: string, action?: MyLeadsLinkAction): string {
  const params = new URLSearchParams({ lead: propertyId });
  if (action) params.set("action", action);
  return `/my-leads?${params.toString()}`;
}
