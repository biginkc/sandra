import type { DropPatch, DropRow, DropStatusStore, ResolveOutcomeInput, ResolveOutcomeResult } from "./status-updates";

export type FakeDrop = DropRow & { to_phone: string; queued_at: string } & Omit<DropPatch, "status" | "drop_id">;

/** In-memory DropStatusStore for tests. */
export type FakeRun = { attempt_outcome: string; claim_active: boolean; recovery_action?: string };
export type FakeEnrollment = { status: string; pause_reason: string | null; current_step_index: number };

/**
 * In-memory DropStatusStore for tests. `runs` / `enrollments` model the step
 * run and enrollment (keyed by step_run_id / enrollment_id); each drop's step
 * is index 0 of a two-step drip. resolveOutcome mirrors
 * resolve_voicemail_drop_outcome + voicemail_drop_settle_enrollment
 * (20261021130000 / 20261021140000); the real-DB matrix proves the SQL.
 */
export function createFakeDropStore(
  drops: FakeDrop[] = [],
  runs: Record<string, FakeRun> = {},
  enrollments: Record<string, FakeEnrollment> = {},
) {
  const events = new Map<string, { status: "processing" | "processed" | "error"; message?: string }>();
  const resolved: ResolveOutcomeInput[] = [];
  /** Every required pause the resolver applied. */
  const paused: Array<{ enrollmentId: string; reason: string }> = [];
  /** Set to make the next N resolveOutcome calls throw (nothing applied). */
  const faults = { resolveFailures: 0 };
  const STEP = 0;
  const LAST_STEP = 1;

  function settle(id: string, enrollment: FakeEnrollment | undefined, eligible: boolean, pauseReason: string | null): string {
    if (!enrollment) return "none";
    if (!eligible) {
      const temporary = ["call_in_progress", "norma_call", "reconciliation_required"];
      if (pauseReason && (enrollment.status === "active" || (enrollment.status === "paused" &&
        enrollment.pause_reason !== pauseReason &&
        (pauseReason === "voicemail_drop_consent_blocked" || temporary.includes(enrollment.pause_reason ?? ""))))) {
        Object.assign(enrollment, { status: "paused", pause_reason: pauseReason });
        paused.push({ enrollmentId: id, reason: pauseReason });
        return "paused";
      }
      return "none";
    }
    if (!["active", "paused"].includes(enrollment.status) || enrollment.current_step_index !== STEP) return "none";
    const last = STEP >= LAST_STEP;
    if (pauseReason) {
      paused.push({ enrollmentId: id, reason: pauseReason });
      Object.assign(enrollment, last
        ? { status: "completed", pause_reason: pauseReason }
        : { status: "paused", pause_reason: pauseReason, current_step_index: STEP + 1 });
      return last ? "completed" : "advanced_paused";
    }
    if (enrollment.status === "active" || enrollment.pause_reason === "reconciliation_required") {
      Object.assign(enrollment, last
        ? { status: "completed", pause_reason: null }
        : { status: "active", pause_reason: null, current_step_index: STEP + 1 });
      return last ? "completed" : "advanced";
    }
    if (last) {
      enrollment.status = "completed";
      return "completed";
    }
    enrollment.current_step_index = STEP + 1;
    return "advanced_paused";
  }

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
    async resolveOutcome(input): Promise<ResolveOutcomeResult> {
      if (faults.resolveFailures > 0) {
        faults.resolveFailures -= 1;
        throw new Error("resolveOutcome: write failed");
      }
      resolved.push(input);
      const drop = drops.find((d) => d.id === input.dropRowId);
      if (!drop) return { dropResult: "not_found", enrollmentAction: "none" };
      // Unseeded rows default to the common case: a drop held at 'unknown'
      // has an unknown run and a paused-on-step enrollment; a 202'd drop has an
      // accepted run and an enrollment already active on the next step.
      const held = drop.attempt_outcome === "unknown";
      runs[drop.step_run_id] ??= { attempt_outcome: held ? "unknown" : "accepted", claim_active: true };
      if (drop.enrollment_id) {
        enrollments[drop.enrollment_id] ??= held
          ? { status: "paused", pause_reason: "reconciliation_required", current_step_index: STEP }
          : { status: "active", pause_reason: null, current_step_index: STEP + 1 };
      }
      const run = runs[drop.step_run_id];
      const enrollment = drop.enrollment_id ? enrollments[drop.enrollment_id] : undefined;
      let owner = false;
      if ((drop.status === "queued" || drop.status === input.status) && drop.attempt_outcome === "unknown" &&
        run && run.claim_active && run.attempt_outcome === "unknown") {
        run.attempt_outcome = "accepted";
        run.recovery_action = "voicemail_drop_reconciled";
        drop.attempt_outcome = "queued";
        owner = true;
      }
      let dropResult: ResolveOutcomeResult["dropResult"];
      const facts = {
        drop_id: drop.drop_id ?? input.dropId ?? null,
        ...(input.cost !== null ? { cost: input.cost } : {}),
        ...(input.proofUrl ? { proof_url: input.proofUrl } : {}),
      };
      if (drop.status === "queued") {
        Object.assign(drop, facts, {
          status: input.status,
          reason_code: input.reasonCode,
          reason: input.reason,
          ...(input.payload !== null ? { provider_payload: input.payload } : {}),
        });
        dropResult = "applied";
      } else {
        Object.assign(drop, facts);
        dropResult = drop.status === input.status ? "replay" : "conflict";
      }
      let enrollmentAction = "none";
      if (enrollment && run && run.claim_active) {
        const eligible = owner || (enrollment.status === "paused" && enrollment.pause_reason === "reconciliation_required" &&
          enrollment.current_step_index === STEP && run.attempt_outcome === "accepted");
        if (eligible) {
          const keepStop = input.pauseReason === "step_misconfigured" && enrollment.status === "paused" &&
            !["reconciliation_required", "call_in_progress", "norma_call"].includes(enrollment.pause_reason ?? "");
          enrollmentAction = settle(drop.enrollment_id!, enrollment, true, keepStop ? null : input.pauseReason);
        }
        else if (dropResult !== "conflict") enrollmentAction = settle(drop.enrollment_id!, enrollment, false, input.pauseReason);
      }
      return { dropResult, enrollmentAction };
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
  return { store, drops, events, resolved, paused, runs, enrollments, faults };
}
