/** Deep link that opens one lead on My Leads (unfiltered, lead pinned and expanded). */
export function myLeadsHref(propertyId: string): string {
  return `/my-leads?${new URLSearchParams({ lead: propertyId }).toString()}`;
}
