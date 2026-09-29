import type { NeedsPersonRow, SequenceRow } from "@/app/(dashboard)/sequences/actions";
import type { NeedsPersonLead } from "@/app/(dashboard)/sequences/needs-person/actions";

const base: SequenceRow = { id: "11111111-1111-4111-8111-111111111111", name: "Seller follow-up", description: "Four texts over 30 days for owners who asked for time.", active: true, append_opt_out: true, archived_at: null, step_count: 4, active_enrollment_count: 38, created_at: "2026-08-01", waiting: 38, replied: 9, finished_no_reply: 21, couldnt_send: 2, stopped: 0 };
export const sampleSequences: SequenceRow[] = [
  base,
  { ...base, id: "22222222-2222-4222-8222-222222222222", name: "Nurture not-interested", description: "A gentle check-in over six months.", step_count: 4, active_enrollment_count: 112, replied: 17, finished_no_reply: 40, couldnt_send: 3 },
  { ...base, id: "33333333-3333-4333-8333-333333333333", name: "Nurture cold lead", description: "Quarterly check-ins for a year.", step_count: 6, active_enrollment_count: 14, replied: 4, finished_no_reply: 6, couldnt_send: 0 },
  { ...base, id: "44444444-4444-4444-8444-444444444444", name: "First touch new lead", description: "Three texts spaced over a week.", step_count: 3, active_enrollment_count: 0, replied: 0, finished_no_reply: 0, couldnt_send: 0 },
  { ...base, id: "55555555-5555-4555-8555-555555555555", name: "Dead lead requalify", description: "A later check-in if a dead lead is ready to revisit.", step_count: 0, active_enrollment_count: 0, replied: 0, finished_no_reply: 0, couldnt_send: 0 },
];
const bucketRows: NeedsPersonRow[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ property_id: `a${i}`, sequence_id: base.id, bucket: "finished_no_reply" as const, reason: "Finished, no reply" })),
  ...Array.from({ length: 5 }, (_, i) => ({ property_id: `b${i}`, sequence_id: base.id, bucket: "couldnt_send" as const, reason: "Couldn’t send" })),
  ...Array.from({ length: 8 }, (_, i) => ({ property_id: `c${i}`, sequence_id: null, bucket: "needs_sequence" as const, reason: "Needs a drip" })),
];
export const sampleNeedsRows: NeedsPersonRow[] = bucketRows;
const addresses = ["7011 Ward Pkwy", "1508 E 78th Terr", "4310 Roanoke Rd", "922 W 39th St", "2717 Charlotte St", "4409 Bellefontaine Ave", "1120 W 43rd St", "2600 Indiana Ave"];
export const sampleNeedsLeads: NeedsPersonLead[] = bucketRows.map((row, i) => ({ ...row, address: addresses[i % addresses.length], status: "contacted", threadId: `contact-${i}` }));
