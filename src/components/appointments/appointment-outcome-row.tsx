"use client";

import { useRef, useState, useTransition } from "react";
import { MoreHorizontalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { callAction } from "@/lib/errors/call-action";

import { BookAppointmentPopover } from "./book-appointment-popover";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
} from "./lifecycle-actions";

type Props = {
  taskId: string;
  /** The appointment's assignee — reschedule never changes assignee, so
   *  this fixes the picker's timezone lookup (see BookAppointmentPopover
   *  `mode="reschedule"`). */
  assigneeId: string;
};

/**
 * "How'd it go?" control for a PAST-DUE open appointment (TasksPanel /
 * lead detail). Held and No-show both complete the appointment with an
 * outcome; Reschedule reopens the booking popover in reschedule mode;
 * Cancel confirms inline (two-click, same pattern as
 * skip-trace-preflight-dialog's `confirmCass` step) before calling
 * `cancelAppointment` — no native `window.confirm`, so the confirmation
 * copy and the disabled/pending state stay consistent with the rest of
 * this row.
 */
export function AppointmentOutcomeRow({ taskId, assigneeId }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  function complete(outcome: "held" | "no_show") {
    startTransition(async () => {
      await callAction(completeAppointmentAction(taskId, outcome), {
        successMessage: outcome === "held" ? "Marked held" : "Marked no-show",
        fallbackMessage: "Could not update the appointment",
      });
    });
  }

  function cancel() {
    if (!confirmingCancel) {
      setConfirmingCancel(true);
      return;
    }
    startTransition(async () => {
      const result = await callAction(cancelAppointmentAction(taskId), {
        successMessage: "Appointment cancelled",
        fallbackMessage: "Could not cancel the appointment",
      });
      if (result.ok) setConfirmingCancel(false);
    });
  }

  return (
    <div
      className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:justify-end"
      data-testid={`appointment-outcome-${taskId}`}
    >
      {!confirmingCancel ? (
        <>
          <span className="text-muted-foreground text-xs font-medium">
            How&rsquo;d it go?
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => complete("held")}
            data-testid={`appointment-held-${taskId}`}
            className="min-h-11 px-3 text-xs"
          >
            Held
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => complete("no_show")}
            data-testid={`appointment-no-show-${taskId}`}
            className="min-h-11 px-3 text-xs"
          >
            No-show
          </Button>
          <div className="[&>button]:min-h-11">
            <BookAppointmentPopover
              mode="reschedule"
              taskId={taskId}
              assigneeId={assigneeId}
              currentUserId={assigneeId}
              triggerLabel="Reschedule"
              triggerVariant="outline"
              triggerSize="sm"
              disabled={pending}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={cancel}
            data-testid={`appointment-cancel-${taskId}`}
            className="min-h-11 px-3 text-xs"
          >
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className="text-muted-foreground text-xs font-medium">
            Cancel this appointment?
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={cancel}
            data-testid={`appointment-cancel-confirm-${taskId}`}
            className="min-h-11 px-3 text-xs"
          >
            {pending ? "Cancelling…" : "Yes, cancel"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirmingCancel(false)}
            data-testid={`appointment-cancel-dismiss-${taskId}`}
            className="min-h-11 px-3 text-xs"
          >
            Never mind
          </Button>
        </>
      )}
    </div>
  );
}

type UpcomingProps = {
  taskId: string;
  /** The appointment's assignee — see `AppointmentOutcomeRow` above. */
  assigneeId: string;
};

/**
 * Compact "..." overflow for an appointment that ISN'T due yet — used in
 * place of the full outcome row (TasksPanel Upcoming rows, lead detail
 * appointments list) so the row stays a single line until there's
 * actually an outcome to record. Reschedule reuses the exact same
 * booking-popover UI as `AppointmentOutcomeRow`: its trigger button is
 * rendered off-screen (`sr-only`) and the menu item opens it via a ref
 * click, so the picker keeps the real `Popover` anchored to a real DOM
 * node instead of trying to nest one interactive popup inside another
 * (a base-ui menu item can't itself host a second floating element).
 */
export function AppointmentUpcomingActions({
  taskId,
  assigneeId,
}: UpcomingProps) {
  const [pending, startTransition] = useTransition();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const rescheduleTriggerRef = useRef<HTMLButtonElement>(null);

  function cancel() {
    if (!window.confirm("Cancel this appointment?")) return;
    startTransition(async () => {
      await callAction(cancelAppointmentAction(taskId), {
        successMessage: "Appointment cancelled",
        fallbackMessage: "Could not cancel the appointment",
      });
    });
  }

  return (
    <div className="relative inline-flex self-start sm:self-auto">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={menuTriggerRef}
              size="sm"
              variant="ghost"
              disabled={pending}
              aria-label="Appointment actions"
              data-testid={`appointment-menu-${taskId}`}
              className="min-h-11 min-w-11 p-0"
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={pending}
            onClick={() => rescheduleTriggerRef.current?.click()}
            data-testid={`appointment-menu-reschedule-${taskId}`}
            className="min-h-11"
          >
            Reschedule
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onClick={cancel}
            data-testid={`appointment-menu-cancel-${taskId}`}
            className="min-h-11"
          >
            Cancel
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Real trigger + Popover, anchored at the same spot as the menu
       *  button above; invisible and inert to pointer/user interaction,
       *  opened only via the ref click above. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-0"
        aria-hidden="true"
      >
        <BookAppointmentPopover
          mode="reschedule"
          taskId={taskId}
          assigneeId={assigneeId}
          currentUserId={assigneeId}
          triggerLabel="Reschedule"
          triggerRef={rescheduleTriggerRef}
          triggerTabIndex={-1}
          onOpenChange={(open) => {
            if (!open) {
              queueMicrotask(() => menuTriggerRef.current?.focus());
            }
          }}
        />
      </div>
    </div>
  );
}
