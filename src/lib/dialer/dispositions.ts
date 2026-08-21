import type { OutreachDispo } from "@/app/(dashboard)/messages/dispo-actions";

export type SoftphoneDisposition = OutreachDispo;

/** The softphone uses the same durable disposition vocabulary as Messages. */
export const SOFTPHONE_DISPOSITIONS: ReadonlyArray<{
  value: SoftphoneDisposition;
  label: string;
  testId: string;
  schedulesCallback?: boolean;
  danger?: boolean;
}> = [
  { value: "nurture", label: "Follow up", testId: "dispo-follow-up", schedulesCallback: true },
  { value: "wrong_number", label: "Wrong number", testId: "dispo-wrong-number" },
  { value: "bad_number", label: "Bad / disconnected #", testId: "dispo-bad-number" },
  { value: "not_interested", label: "Not interested", testId: "dispo-not-interested" },
  { value: "needs_sequence", label: "Needs sequence", testId: "dispo-needs-sequence" },
  { value: "opted_out", label: "SMS opted out", testId: "dispo-opted-out", danger: true },
  { value: "dnc", label: "Do not call", testId: "dispo-dnc", danger: true },
];
