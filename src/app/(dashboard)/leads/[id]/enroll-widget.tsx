"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";
import {
  cancelEnrollment,
  enrollLeadInSequence,
  listPropertyEnrollments,
  listSequences,
  resumeEnrollmentAction,
} from "@/app/(dashboard)/sequences/actions";

type ActiveSequence = { id: string; name: string; active: boolean; step_count: number };
type Enrollment = {
  id: string;
  status: string;
  pause_reason: string | null;
  current_step_index: number;
  next_run_at: string | null;
  sequence: { id: string; name: string };
};

/**
 * Lead-detail widget: shows active enrollments + an "Enroll" dropdown
 * to add a new one. Minimal V1 UI — no inline resume from within here
 * yet (click into /sequences instead); paused can be cancelled.
 */
export function EnrollInSequenceWidget({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sequences, setSequences] = useState<ActiveSequence[]>([]);
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

  const loadSequences = async () => {
    const r = await listSequences();
    if (r.ok) {
      setSequences(
        r.data
          .filter((s) => s.active && !s.archived_at && s.step_count > 0)
          .map((s) => ({
            id: s.id,
            name: s.name,
            active: s.active,
            step_count: s.step_count,
          })),
      );
    }
  };

  const onEnroll = (sequenceId: string) => {
    startTransition(async () => {
      const r = await callAction(
        enrollLeadInSequence(sequenceId, propertyId),
        {
          successMessage: "Enrolled",
          fallbackMessage: "Could not enroll",
        },
      );
      if (r.ok) {
        setOpen(false);
        await refreshEnrollments();
        router.refresh();
      }
    });
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

  const activeOrPaused = enrollments.filter(
    (e) => e.status === "active" || e.status === "paused",
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(!open);
            if (!open) void loadSequences();
          }}
          disabled={pending}
          data-testid="enroll-in-sequence-button"
        >
          {activeOrPaused.length > 0
            ? `🔄 Sequences (${activeOrPaused.length})`
            : "Enroll in sequence"}
        </Button>
        {open && (
          <div className="bg-popover absolute z-50 mt-1 flex w-64 flex-col gap-1 rounded-md border p-2 shadow-md">
            {sequences.length === 0 ? (
              <div className="text-muted-foreground p-2 text-xs">
                No active sequences with steps. Ask an admin to create and
                activate one before enrolling this lead.
              </div>
            ) : (
              sequences.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onEnroll(s.id)}
                  className="hover:bg-accent rounded-md px-2 py-1.5 text-left text-sm"
                  disabled={pending}
                >
                  {s.name}
                  <span className="text-muted-foreground ml-1 text-xs">
                    ({s.step_count} step{s.step_count === 1 ? "" : "s"})
                  </span>
                </button>
              ))
            )}
          </div>
        )}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onResume(e.id)}
                    disabled={pending}
                  >
                    Resume
                  </Button>
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
