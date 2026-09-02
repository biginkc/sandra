export const LEAD_SOURCE_LABELS: Readonly<Record<string, string>> = {
  dealmachine: "DealMachine",
  propstream: "PropStream",
  titlepro: "TitlePro",
  reisift: "REISift",
  agent_outreach: "Agent outreach",
  driving_for_dollars: "Driving for dollars",
  referral: "Referral",
  cold_call: "Cold call",
  sms: "SMS (inbound)",
  web_form: "Web form",
  direct_mail: "Direct mail",
};

export const PROPERTY_STATUS_LABELS: Readonly<Record<string, string>> = {
  prospect: "Prospect",
  new_lead: "New lead",
  contacted: "Contacted",
  interested: "Interested",
  offer_sent: "Offer sent",
  offer_declined: "Offer declined",
  under_contract: "Under contract",
  closed: "Closed",
  dead: "Dead",
};

export const SEQUENCE_ACTION_LABELS: Readonly<Record<string, string>> = {
  send_sms: "Send SMS",
  change_status: "Change status",
};

export const MEMBERSHIP_ROLE_LABELS: Readonly<Record<string, string>> = {
  owner: "Owner",
  member: "Member",
};

export function systemLabel(
  labels: Readonly<Record<string, string>>,
  value: string,
): string {
  return labels[value] ?? value;
}
