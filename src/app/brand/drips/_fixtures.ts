/** Stable display data for public drip design previews. No customer records. */
export const dripBrandFixture = {
  title: "Drips",
  description: "Follow-up texts that run on a schedule",
  sampleName: "Seller follow-up",
  sampleStatus: "Open to new leads",
} as const;

import type { DripProgress } from "@/lib/sequences/drip-progress";

export const activeLeadDrip: DripProgress = {
  propertyId: "brand-lead", enrollmentId: "brand-enrollment", enrollmentStatus: "active", sequenceId: "brand-sequence",
  sequenceName: "90-day follow-up", step: 3, totalSteps: 4,
  nextTextAt: "2026-10-09T14:00:00Z", lastText: { sentAt: "2026-09-29T14:02:00Z", preview: "Checking in on your property" },
  status: "Waiting", reason: null,
};
