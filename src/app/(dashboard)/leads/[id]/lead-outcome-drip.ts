import type { DripProgress } from "@/lib/sequences/drip-progress";

/** Active-drip props for the outcome bar; all null unless the lead has a live drip. */
export type OutcomeBarDrip = {
  activeDripEnrollmentId: string | null;
  activeDripSequenceId: string | null;
  activeDripName: string | null;
  activeDripStep: number | null;
  activeDripTotal: number | null;
};

export const NO_ACTIVE_DRIP: OutcomeBarDrip = {
  activeDripEnrollmentId: null,
  activeDripSequenceId: null,
  activeDripName: null,
  activeDripStep: null,
  activeDripTotal: null,
};

export function toOutcomeBarDrip(progress: DripProgress | null | undefined): OutcomeBarDrip {
  if (!progress) return NO_ACTIVE_DRIP;
  if (progress.enrollmentStatus !== "active" && progress.enrollmentStatus !== "paused") {
    return NO_ACTIVE_DRIP;
  }
  return {
    activeDripEnrollmentId: progress.enrollmentId,
    activeDripSequenceId: progress.sequenceId,
    activeDripName: progress.sequenceName,
    activeDripStep: progress.step,
    activeDripTotal: progress.totalSteps,
  };
}
