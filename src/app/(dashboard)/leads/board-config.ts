import type { PropertyStatus } from "./actions";

export const STATUS_ORDER: readonly PropertyStatus[] = [
  "new_lead",
  "contacted",
  "interested",
  "offer_sent",
  "offer_declined",
  "under_contract",
  "closed",
  "dead",
];

export const DEFAULT_COLLAPSED_STATUSES: readonly PropertyStatus[] = [
  "closed",
  "dead",
];

export const STATUS_LABEL: Record<PropertyStatus, string> = {
  prospect: "Prospect",
  new_lead: "New Lead",
  contacted: "Contacted",
  interested: "Interested",
  offer_sent: "Offer Sent",
  offer_declined: "Offer Declined",
  under_contract: "Under Contract",
  closed: "Closed",
  dead: "Dead",
};

export const STATUS_ACCENT: Record<PropertyStatus, string> = {
  prospect: "border-t-slate-400",
  new_lead: "border-t-blue-500",
  contacted: "border-t-cyan-500",
  interested: "border-t-amber-500",
  offer_sent: "border-t-orange-500",
  offer_declined: "border-t-rose-500",
  under_contract: "border-t-violet-500",
  closed: "border-t-emerald-500",
  dead: "border-t-zinc-400",
};
