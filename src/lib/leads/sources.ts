/** Canonical `properties.source` vocabulary shared by server and client code. */
export const LEAD_SOURCES = [
  "dealmachine",
  "propstream",
  "titlepro",
  "reisift",
  "agent_outreach",
  "driving_for_dollars",
  "referral",
  "cold_call",
  "sms",
  "web_form",
  "direct_mail",
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];
