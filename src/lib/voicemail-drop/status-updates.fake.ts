import type { DropPatch, DropRow, DropStatusStore } from "./status-updates";

export type FakeDrop = DropRow & { to_phone: string; queued_at: string } & Omit<DropPatch, "status" | "drop_id">;

/** In-memory DropStatusStore for tests. */
export type FakeRun = { attempt_outcome: string; claim_active: boolean; recovery_action?: string };
export type FakeEnrollment = { status: string; pause_reason: string | null; current_step_index: number };

/**
 * In-memory DropStatusStore for tests. `runs` / `enrollments` model the step
 * run and enrollment a held drop reconciles (keyed by step_run_id /
 * enrollment_id); each drop's step is index 0 of a two-step drip.
 */
export function createFakeDropStore(
  drops: FakeDrop[] = [],
  runs: Record<string, FakeRun> = {},
  enrollments: Record<string, FakeEnrollment> = {},
) {
  const events = new Map<string, { status: "processing" | "processed" | "error"; message?: string }>();
  const paused: Array<{ enrollmentId: string; reason: string }> = [];
  /** Set to make the next N pauseEnrollment calls throw. */
  const faults = { pauseFailures: 0 };
  const store: DropStatusStore = {
    async findDropById(id) {
      return drops.find((d) => d.id === id) ?? null;
    },
    async findDropsByDropId(dropId) {
      return drops.filter((d) => d.drop_id === dropId);
    },
    async findQueuedDropsByPhone(phone, sinceIso, dropId) {
      return drops.filter(
        (d) =>
          d.to_phone === phone &&
          d.status === "queued" &&
          d.queued_at >= sinceIso &&
          (!dropId || !d.drop_id || d.drop_id === dropId),
      );
    },
    async updateDrop(id, patch, onlyIfStatusIn) {
      const drop = drops.find((d) => d.id === id);
      if (!drop || (onlyIfStatusIn && !onlyIfStatusIn.includes(drop.status))) return false;
      Object.assign(drop, patch as Partial<FakeDrop>);
      return true;
    },
    async reconcileHeldDrop(row) {
      const drop = drops.find((d) => d.id === row.id);
      if (!drop || drop.attempt_outcome !== "unknown" || drop.status !== "queued") return "not_held";
      const run = runs[drop.step_run_id];
      if (!run || !run.claim_active || !["unknown", "accepted"].includes(run.attempt_outcome)) return "not_held";
      if (run.attempt_outcome === "unknown") {
        run.attempt_outcome = "accepted";
        run.recovery_action = "voicemail_drop_reconciled";
      }
      const enrollment = drop.enrollment_id ? enrollments[drop.enrollment_id] : undefined;
      if (enrollment && enrollment.status === "paused" && enrollment.pause_reason === "reconciliation_required" && enrollment.current_step_index === 0) {
        Object.assign(enrollment, { status: "active", pause_reason: null, current_step_index: 1 });
      }
      drop.attempt_outcome = "queued";
      row.attempt_outcome = "queued";
      return "reconciled";
    },
    async pauseEnrollment(enrollmentId, reason) {
      if (faults.pauseFailures > 0) {
        faults.pauseFailures -= 1;
        throw new Error("pauseEnrollment: write failed");
      }
      paused.push({ enrollmentId, reason });
    },
    async reserveEvent(eventType, eventId) {
      const key = `${eventType}:${eventId}`;
      const existing = events.get(key);
      if (existing && existing.status !== "error") return "skip";
      events.set(key, { status: "processing" });
      return "reserved";
    },
    async finishEvent(eventType, eventId, outcome, message) {
      events.set(`${eventType}:${eventId}`, { status: outcome, message });
    },
  };
  return { store, drops, events, paused, runs, enrollments, faults };
}
