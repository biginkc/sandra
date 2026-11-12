"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { toast } from "sonner";

import {
  moveMessageThreadToLead,
  setInboxDispoAndStartDrip,
  setOutreachDispo,
  type OutreachDispo,
} from "@/app/(dashboard)/messages/dispo-actions";
import { changeDripAction, startDripForLeads } from "@/app/(dashboard)/sequences/actions";
import { BookAppointmentPopover } from "@/components/appointments/book-appointment-popover";
import { StartDripPicker, type PickResult } from "@/components/sequences/start-drip-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export const DISPO_LABELS: Record<string, string> = {
  wrong_number: "Wrong #",
  bad_number: "Bad / disconnected #",
  not_interested: "Not interested",
  needs_sequence: "Needs drip",
  opted_out: "SMS opted out",
  dnc: "Do not call",
  nurture: "Follow up",
  callback_requested: "Lead task requested",
  booked_appointment: "Booked appointment",
};

/** Outcomes whose server side effects may pause or stop a drip enrollment. */
const DRIP_AFFECTING_DISPOS = new Set<string>([
  "opted_out",
  "dnc",
  "wrong_number",
  "bad_number",
]);

function outcomeButtonClass(
  isActive: boolean,
  activeClass = "bg-[#f5f5f4] border-[#e5e1df] text-[#1c1917]",
) {
  return cn(
    "min-h-11 px-3 py-1 text-[11px] font-medium rounded-md border transition-colors",
    isActive
      ? activeClass
      : "border-[#e5e1df] text-[#78716c] hover:bg-[#f5f5f4]",
  );
}

export function OutcomeBar({
  propertyId,
  contactId = null,
  propertyAddress,
  initialDispo,
  propertyStatus,
  currentUserId,
  onDispositionChanged,
  activeDripEnrollmentId,
  activeDripSequenceId,
  initialFailedStart,
  onDripChanged,
  showMoveToLead = true,
  showBookAppointment = true,
  syncFromProps = false,
  dripPickersDisabled = false,
}: {
  propertyId: string;
  /** Required only while the Book appt control is shown. */
  contactId?: string | null;
  propertyAddress: string | null;
  initialDispo: string | null;
  propertyStatus: string | null;
  currentUserId: string | null;
  onDispositionChanged?: () => void;
  activeDripEnrollmentId?: string | null;
  activeDripSequenceId?: string | null;
  activeDripName?: string | null;
  activeDripStep?: number | null;
  activeDripTotal?: number | null;
  initialFailedStart?: { reason: string; sequenceId: string; saved: boolean } | null;
  /** Fired when a drip enrollment may have started, changed or been paused. */
  onDripChanged?: () => void;
  showMoveToLead?: boolean;
  showBookAppointment?: boolean;
  /** Follow `initialDispo` when the server value changes (no remount). */
  syncFromProps?: boolean;
  /** Disables the drip pickers when the current drip state could not be read. */
  dripPickersDisabled?: boolean;
}) {
  const router = useRouter();
  const [dispo, setDispo] = useState<string | null>(initialDispo);
  const [wasMovedToLead, setWasMovedToLead] = useState(false);
  const [pending, startTransition] = useTransition();
  const [failedStart, setFailedStart] = useState<{ reason: string; sequenceId: string; saved: boolean } | null>(initialFailedStart ?? null);
  const [switching, setSwitching] = useState(false);
  const isLead = propertyStatus !== "prospect" || wasMovedToLead;

  // Follow the server value when it changes (adjust-state-during-render, no effect or remount).
  const [seenInitialDispo, setSeenInitialDispo] = useState(initialDispo);
  if (seenInitialDispo !== initialDispo) {
    setSeenInitialDispo(initialDispo);
    if (syncFromProps) setDispo(initialDispo);
  }

  function notifySuccess(message: string) {
    toast.success(message, { description: propertyAddress ?? "Address unavailable" });
  }

  function notifyError(message: string) {
    toast.error(message, { description: propertyAddress ?? "Address unavailable" });
  }

  function apply(newDispo: OutreachDispo) {
    startTransition(async () => {
      const previousDispo = dispo;
      const result = await setOutreachDispo(propertyId, newDispo).catch(() => ({ ok: false as const, error: "Could not confirm the outcome. Check its current status before retrying.", committed: false }));
      if (result.ok) {
        setDispo(newDispo);
        notifySuccess(
          newDispo === "wrong_number"
            ? "Marked wrong number — consider skip-tracing a new number."
            : `Saved: ${DISPO_LABELS[newDispo]}`,
        );
        if (previousDispo !== newDispo) onDispositionChanged?.();
        if (DRIP_AFFECTING_DISPOS.has(newDispo)) onDripChanged?.();
      } else if (result.committed) {
        // The outcome is saved even though the action reported a failure.
        setDispo(newDispo);
        if (previousDispo !== newDispo) onDispositionChanged?.();
        if (DRIP_AFFECTING_DISPOS.has(newDispo)) onDripChanged?.();
        notifyError(result.error);
      } else {
        notifyError(result.error);
      }
    });
  }

  function handleDripResult(result: PickResult, sequenceId: string) {
    setFailedStart(result.status === "enrolled" ? null : { reason: result.reason, sequenceId, saved: result.saved !== false });
    if (result.status === "enrolled") {
      notifySuccess("Drip started");
    } else {
      notifyError(`${result.saved !== false ? "Outcome saved. " : ""}Drip not started: ${result.reason}`);
    }
  }

  async function chooseDrip(sequenceId: string, afterSavedOutcome = false): Promise<PickResult> {
    try {
      return await chooseDripResult(sequenceId, afterSavedOutcome);
    } catch (error) {
      notifyError("Could not confirm the drip start. Check its current status before retrying.");
      throw error;
    }
  }

  async function chooseDripResult(sequenceId: string, afterSavedOutcome: boolean): Promise<PickResult> {
    // Let the server check protected outcomes and the current enrollment,
    // even when this render already knows about an active or paused drip.
    if (afterSavedOutcome) {
      const result = await startDripForLeads(sequenceId, [propertyId]);
      if (!result.ok) return { status: "failed", reason: result.error.message, saved: false };
      const enrollment = result.data.results[0];
      if (enrollment.status === "enrolled") onDripChanged?.();
      return enrollment.status === "enrolled" ? enrollment : { ...enrollment, saved: false };
    }
    const result = await setInboxDispoAndStartDrip(propertyId, "needs_sequence", sequenceId);
    if (!result.ok) {
      if (result.committed) {
        setDispo("needs_sequence");
        onDispositionChanged?.();
        onDripChanged?.();
      }
      return { status: "failed", reason: result.error, saved: result.committed === true };
    }
    setDispo("needs_sequence");
    onDispositionChanged?.();
    onDripChanged?.();
    return result.enrollment ?? { status: "failed", reason: "Could not enroll this lead." };
  }

  async function switchDrip() {
    if (!activeDripEnrollmentId || !failedStart) return;
    setSwitching(true);
    try {
      const result = await changeDripAction(activeDripEnrollmentId, failedStart.sequenceId);
      if (!result.ok) { setFailedStart({ ...failedStart, reason: result.error.message }); notifyError(result.error.message); return; }
      if (result.data.status !== "enrolled") { setFailedStart({ ...failedStart, reason: result.data.reason }); notifyError(result.data.reason); return; }
      setFailedStart(null);
      onDispositionChanged?.();
      notifySuccess("Switched drip");
      router.refresh();
    } catch {
      const reason = "Could not switch drips. Open the lead to review its current drip.";
      setFailedStart({ ...failedStart, reason });
      notifyError(reason);
    } finally { setSwitching(false); onDripChanged?.(); }
  }

  async function leaveToOwner() {
    const result = await setOutreachDispo(propertyId, "needs_sequence").catch(() => ({ ok: false as const, committed: false, error: "Could not confirm the outcome. Check its current status before retrying." }));
    if (!result.ok) {
      if (result.committed) {
        setDispo("needs_sequence");
        onDispositionChanged?.();
        onDripChanged?.();
      }
      notifyError(result.error);
      throw new Error(result.error);
    }
    setDispo("needs_sequence");
    onDispositionChanged?.();
    onDripChanged?.();
    notifySuccess("Saved: Needs drip — left for lead owner");
  }

  function moveToLead() {
    startTransition(async () => {
      const result = await moveMessageThreadToLead(propertyId).catch(() => ({ ok: false as const, error: "Could not confirm the move to lead. Check its current status before retrying." }));
      if (result.ok) {
        setWasMovedToLead(true);
        notifySuccess(
          result.alreadyQualified ? "Already a lead" : "Moved to lead",
        );
        router.refresh();
      } else {
        notifyError(result.error);
      }
    });
  }

  const isPermanentDnc = dispo === "dnc";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-bold text-[#78716c]">
        How&apos;d it go?
      </span>

      <button
        onClick={() => apply("wrong_number")}
        disabled={pending}
        className={outcomeButtonClass(dispo === "wrong_number")}
        data-testid="dispo-wrong-number"
      >
        Wrong number
      </button>

      <button
        onClick={() => apply("not_interested")}
        disabled={pending}
        className={outcomeButtonClass(dispo === "not_interested")}
        data-testid="dispo-not-interested"
      >
        Not interested
      </button>
      {dispo === "not_interested" && <StartDripPicker triggerLabel="Also start a drip" onChoose={(id) => chooseDrip(id, true)} disabled={pending || dripPickersDisabled}
        onResult={handleDripResult} />}

      <button
        onClick={() => apply("nurture")}
        disabled={pending}
        className={outcomeButtonClass(
          dispo === "nurture",
          "bg-blue-50 border-blue-200 text-blue-800",
        )}
        data-testid="dispo-follow-up"
      >
        Follow up
      </button>

      <button
        type="button"
        disabled
        className={cn(
          outcomeButtonClass(false),
          "cursor-not-allowed opacity-60",
        )}
        data-testid="dispo-dnc-deferred"
        title="Permanent DNC requires the deferred confirmed compliance workflow."
      >
        Permanent DNC unavailable here
      </button>

      <div data-testid="dispo-needs-sequence">
        <StartDripPicker triggerLabel="Needs drip" onChoose={chooseDrip} onLeave={leaveToOwner} disabled={pending || dripPickersDisabled}
          onResult={handleDripResult} />
      </div>
      {failedStart ? <div className="w-full rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-stone-800" role="alert" data-testid="drip-cant-start">
        <p className="font-bold">Can&apos;t start this drip</p>
        <p className="mt-1">{failedStart.saved ? "The outcome was saved. " : ""}{failedStart.reason}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {activeDripEnrollmentId && failedStart.sequenceId !== activeDripSequenceId && /already in/i.test(failedStart.reason) ? <button type="button" disabled={switching} onClick={() => void switchDrip()} className="font-semibold text-teal-800 underline">Switch to this drip</button> : null}
          <Link href={`/leads/${propertyId}`} className="font-semibold text-teal-800 underline">Open lead</Link>
        </div>
      </div> : null}

      {showMoveToLead ? (
      <button
        onClick={moveToLead}
        disabled={pending || isLead}
        className="min-h-11 rounded-md border border-[#111827] bg-[#111827] px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[#292524] disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="message-move-to-lead"
        title={isLead ? "Already a lead" : undefined}
      >
        Move to Lead
      </button>
      ) : null}

      {showBookAppointment && contactId ? (
      <BookAppointmentPopover
        propertyId={propertyId}
        contactId={contactId}
        subjectLabel={propertyAddress ?? undefined}
        currentUserId={currentUserId}
        triggerLabel="Book appt"
        disabled={pending}
        onBooked={() => {
          setDispo("booked_appointment");
          onDispositionChanged?.();
        }}
      />
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              disabled={pending}
              className="inline-flex min-h-11 items-center gap-1 rounded-md border border-[#e5e1df] px-3 py-1 text-[11px] font-medium text-[#78716c] transition-colors hover:bg-[#f5f5f4] hover:text-[#1c1917]"
              data-testid="dispo-more"
            >
              More
              <ChevronDownIcon className="h-3 w-3" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => apply("bad_number")}
            data-testid="dispo-bad-number"
          >
            Bad / disconnected #
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => apply("opted_out")}
            data-testid="dispo-opted-out"
          >
            SMS opt-out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dispo ? (
        <span
          className={cn(
            "ml-1 text-[10px] font-medium",
            isPermanentDnc ? "text-destructive" : "text-[#78716c]",
          )}
        >
          {DISPO_LABELS[dispo] ?? dispo}
        </span>
      ) : null}
    </div>
  );
}
