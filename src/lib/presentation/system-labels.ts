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

export const CASS_STATUS_LABELS: Readonly<Record<string, string>> = {
  verified: "Verified",
  unverified: "Not verified",
  invalid: "Invalid address",
  ambiguous: "Needs review",
};

export const OUTREACH_DISPOSITION_LABELS: Readonly<Record<string, string>> = {
  wrong_number: "Wrong number",
  bad_number: "Bad or disconnected number",
  not_interested: "Not interested",
  opted_out: "SMS opted out",
  dnc: "Do not call",
  nurture: "Follow up",
  callback_requested: "Callback requested",
  needs_sequence: "Needs sequence",
};

export const JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  cass_dsf2_ncoa: "Address verification",
  csv_import: "CSV import",
  skip_trace: "Skip trace",
  bulk_sms: "Bulk SMS",
  promote_leads: "Promote leads",
};

export const JOB_STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: "Queued",
  pending: "Pending",
  pending_approval: "Pending approval",
  processing: "Processing",
  running: "Running",
  completed: "Completed",
  partially_completed: "Partially completed",
  partial: "Completed with errors",
  failed: "Failed",
  canceled: "Canceled",
  skipped: "Skipped",
  success: "Successful",
};

export function humanizeMachineValue(value: string): string {
  const words = value.replaceAll("_", " ").trim();
  if (!words) return value;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function systemLabel(
  labels: Readonly<Record<string, string>>,
  value: string,
): string {
  return labels[value] ?? humanizeMachineValue(value);
}
