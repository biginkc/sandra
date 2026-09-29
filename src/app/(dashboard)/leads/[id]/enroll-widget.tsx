"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { StartDripPicker, type PickResult } from "@/components/sequences/start-drip-picker";
import { callAction } from "@/lib/errors/call-action";
import {
  cancelEnrollment,
  listPropertyEnrollments,
  startDripForLeads,
  retrySequenceStepAction,
  resumeEnrollmentAction,
} from "@/app/(dashboard)/sequences/actions";

type Enrollment = {
  id: string;
  status: string;
  pause_reason: string | null;
  current_step_index: number;
  next_run_at: string | null;
  sequence: { id: string; name: string };
  current_run: {
    id: string;
    attempt_outcome: string;
    failure_reason: string | null;
    message_id: string | null;
  } | null;
};

/**
 * Lead-detail widget: shows active enrollments + an "Enroll" dropdown
 * to add a new one. Minimal V1 UI — no inline resume from within here
 * yet (click into /sequences instead); paused can be cancelled.
 */
export function EnrollInSequenceWidget({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const r = await listPropertyEnrollments(propertyId);
      if (!cancelled && r.ok) setEnrollments(r.data);
    })();

    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  const refreshEnrollments = async () => {
    const r = await listPropertyEnrollments(propertyId);
    if (r.ok) setEnrollments(r.data);
  };

  const onEnroll = async (sequenceId: string): Promise<PickResult> => {
    const result = await startDripForLeads(sequenceId, [propertyId]);
    if (!result.ok) return { status: "failed", reason: result.error.message, saved: false };
    const outcome = result.data.results[0];
    if (outcome.status === "enrolled") {
      await refreshEnrollments();
      router.refresh();
    }
    return { ...outcome, saved: false };
  };

  const onCancel = (enrollmentId: string) => {
    if (!window.confirm("Cancel this enrollment? No more messages will fire.")) return;
    startTransition(async () => {
      const r = await callAction(cancelEnrollment(enrollmentId), {
        successMessage: "Enrollment cancelled",
        fallbackMessage: "Could not cancel",
      });
      if (r.ok) await refreshEnrollments();
    });
  };

  const onResume = (enrollmentId: string) => {
    startTransition(async () => {
      const r = await callAction(resumeEnrollmentAction(enrollmentId), {
        successMessage: "Resumed",
        fallbackMessage: "Could not resume",
      });
      if (r.ok) await refreshEnrollments();
    });
  };

  const onRetry = (enrollmentId: string) => {
    startTransition(async () => {
      const r = await callAction(retrySequenceStepAction(enrollmentId), {
        successMessage: "Retry scheduled",
        fallbackMessage: "Could not safely retry this step",
      });
      if (r.ok) await refreshEnrollments();
    });
  };

  const activeOrPaused = enrollments.filter(
    (e) => e.status === "active" || e.status === "paused",
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div data-testid="enroll-in-sequence-button">
          <StartDripPicker triggerLabel={activeOrPaused.length > 0 ? `Drips (${activeOrPaused.length})` : "Start follow-up drip"} onChoose={onEnroll} disabled={pending} />
        </div>
      </div>

      {activeOrPaused.length > 0 && (
        <div className="flex flex-col gap-1">
          {activeOrPaused.map((e) => (
            <div
              key={e.id}
              className="flex items-center justify-between rounded-md border px-2 py-1 text-xs"
            >
              <span>
                <span className="font-medium">{e.sequence.name}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · step {e.current_step_index + 1}
                </span>
                {e.status === "paused" && (
                  <span className="text-muted-foreground">
                    {" "}
                    · paused ({e.pause_reason})
                  </span>
                )}
              </span>
              <div className="flex items-center gap-1">
                {e.status === "paused" && (
                  e.pause_reason === "provider_failed" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRetry(e.id)}
                      disabled={pending}
                    >
                      Retry step
                    </Button>
                  ) : e.pause_reason === "reconciliation_required" ? (
                    <span className="text-amber-700" title="Cancel is the safe terminal action; delivery is never retried from this state.">
                      Reconcile delivery · claim {e.current_run?.id ?? "unavailable"} · outcome {e.current_run?.attempt_outcome ?? "unknown"} · {e.current_run?.failure_reason ?? "provider delivery outcome is unknown"}
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onResume(e.id)}
                      disabled={pending}
                    >
                      Resume
                    </Button>
                  )
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onCancel(e.id)}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
