"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { CalendarIcon } from "lucide-react";

import { AssigneeSelect } from "@/app/(dashboard)/messages/_components/assignee-select";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/errors/call-action";
import { wallTimeToUtc } from "@/lib/time/zoned";

import {
  bookAppointment,
  checkAppointmentOverlap,
  getMemberTimezone,
  type BookAppointmentResult,
} from "./book-appointment-action";

type Props = {
  /** Property this appointment links to, if any. */
  propertyId?: string;
  /** Contact this appointment links to, if any — independent of property. */
  contactId?: string;
  /** Human label used to build the appointment title (e.g. property
   *  address) and shown in the "with <label>" conflict/overlap copy. */
  subjectLabel?: string;
  currentUserId: string | null;
  /** Trigger button content; defaults to "Book appt". */
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "secondary" | "ghost";
  triggerSize?: "default" | "sm" | "xs";
  disabled?: boolean;
  onBooked?: (result: BookAppointmentResult) => void;
};

const DURATION_OPTIONS = [15, 30, 45, 60, 90] as const;
const DEFAULT_DURATION_MINUTES = 30;

/** 15-minute steps across a full day: "00:00".."23:45". */
const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const hour = Math.floor(i / 4);
  const minute = (i % 4) * 15;
  const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const label = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2000, 0, 1, hour, minute));
  return { value, label };
});

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * "Central Time" style generic zone label (no Standard/Daylight suffix,
 * no abbreviation) via Intl's `longGeneric` — falls back to the bare IANA
 * id if the runtime doesn't support that style.
 */
function friendlyZoneName(timeZone: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longGeneric",
    }).formatToParts(now);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

function formatConflictTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * Composed booking form: date (Calendar) + time + duration (defaults to
 * 30 min, computes end) + assignee + optional note. Shows the assignee's
 * authoritative timezone ("Times in Central Time (America/Chicago)") and
 * converts wall time -> UTC the same way the server does (`zoned.ts`), so
 * a nonexistent DST time is caught before submit instead of round-tripping
 * an error. Soft double-book: warns, never blocks (locked decision #7).
 */
export function BookAppointmentPopover({
  propertyId,
  contactId,
  subjectLabel,
  currentUserId,
  triggerLabel = "Book appt",
  triggerVariant = "outline",
  triggerSize = "sm",
  disabled,
  onBooked,
}: Props) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [time, setTime] = useState<string>("");
  const [durationMinutes, setDurationMinutes] = useState<number>(
    DEFAULT_DURATION_MINUTES,
  );
  const [assigneeId, setAssigneeId] = useState<string | null>(currentUserId);
  const [note, setNote] = useState("");
  const [timezone, setTimezone] = useState<string | null>(null);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const [overlap, setOverlap] = useState<{
    hasOverlap: boolean;
    conflictStartAt: string | null;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  // Reset the ephemeral form state whenever the popover is reopened so a
  // stale date/time from a previous booking on the same record doesn't
  // linger.
  useEffect(() => {
    if (!open) return;
    setDate(undefined);
    setTime("");
    setDurationMinutes(DEFAULT_DURATION_MINUTES);
    setAssigneeId(currentUserId);
    setNote("");
    setOverlap(null);
  }, [open, currentUserId]);

  useEffect(() => {
    // Gated on `open` — the trigger renders on every row/detail panel, and
    // `assigneeId` defaults to `currentUserId` before the user ever opens
    // it, so an ungated effect would fire a server round-trip for every
    // closed popover on the page.
    if (!open || !assigneeId) {
      setTimezone(null);
      return;
    }
    let cancelled = false;
    setTimezoneError(null);
    getMemberTimezone(assigneeId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setTimezone(result.data);
      } else {
        setTimezone(null);
        setTimezoneError(result.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, assigneeId]);

  const dateKey = date ? toDateKey(date) : "";
  const conversion = useMemo(() => {
    if (!dateKey || !time || !timezone) return null;
    return wallTimeToUtc({ date: dateKey, time, timeZone: timezone });
  }, [dateKey, time, timezone]);
  const dstError =
    conversion && !conversion.ok && conversion.reason === "nonexistent"
      ? "That time doesn't exist in this timezone because of a daylight-saving change — pick another."
      : null;
  // End-time preview: derived from the resolved UTC instant (not naive
  // local-time addition), so it stays correct even when the appointment
  // window itself straddles a DST transition.
  const endLabel =
    conversion?.ok && timezone
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(conversion.utc.getTime() + durationMinutes * 60_000))
      : null;

  // Soft overlap check — debounced, non-blocking, cleared whenever the
  // inputs it depends on change so a stale warning never survives an edit.
  useEffect(() => {
    setOverlap(null);
    if (!assigneeId || !conversion?.ok) return;
    const startUtc = conversion.utc;
    const endUtc = new Date(startUtc.getTime() + durationMinutes * 60_000);
    const handle = setTimeout(() => {
      checkAppointmentOverlap(
        assigneeId,
        startUtc.toISOString(),
        endUtc.toISOString(),
      ).then((result) => {
        if (result.ok) setOverlap(result.data);
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [assigneeId, conversion, durationMinutes]);

  const canSubmit =
    Boolean(date && time && assigneeId && timezone && !dstError) && !pending;

  const submit = () => {
    if (!canSubmit || !assigneeId || !timezone) return;
    const title = subjectLabel
      ? `Appointment — ${subjectLabel}`
      : "Appointment";
    startTransition(async () => {
      const result = await callAction(
        bookAppointment({
          propertyId,
          contactId,
          assigneeId,
          date: dateKey,
          time,
          timeZone: timezone,
          durationMinutes,
          title,
          note: note.trim() || undefined,
        }),
        {
          successMessage: "Appointment booked",
          fallbackMessage: "Could not book the appointment",
        },
      );
      if (result.ok) {
        setOpen(false);
        onBooked?.(result.data);
      }
    });
  };

  const zoneLabel = timezone
    ? `Times in ${friendlyZoneName(timezone, new Date())} (${timezone})`
    : null;
  const conflictLabel =
    overlap?.hasOverlap && overlap.conflictStartAt && timezone
      ? `Already has a ${formatConflictTime(overlap.conflictStartAt, timezone)} appointment — book anyway?`
      : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant={triggerVariant}
            size={triggerSize}
            disabled={disabled}
            data-testid="book-appointment-trigger"
          >
            <CalendarIcon className="h-3.5 w-3.5" />
            {triggerLabel}
          </Button>
        }
      />
      <PopoverContent
        align="start"
        className="w-80"
        data-testid="book-appointment-popover"
      >
        <div className="flex flex-col gap-3">
          <Calendar
            mode="single"
            selected={date}
            onSelect={setDate}
            disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
            data-testid="book-appointment-calendar"
          />

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Time
              <Select value={time} onValueChange={(v) => setTime(v ?? "")}>
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  data-testid="book-appointment-time"
                >
                  <SelectValue placeholder="Choose time" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {TIME_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Duration
              <Select
                value={String(durationMinutes)}
                onValueChange={(v) => setDurationMinutes(Number(v ?? DEFAULT_DURATION_MINUTES))}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  data-testid="book-appointment-duration"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {minutes} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          {endLabel ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="book-appointment-end-label"
            >
              Ends at {endLabel}
            </p>
          ) : null}

          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Assignee
            <AssigneeSelect
              value={assigneeId}
              onChange={setAssigneeId}
              currentUserId={currentUserId}
              disabled={pending}
            />
          </label>

          {zoneLabel ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="book-appointment-timezone-label"
            >
              {zoneLabel}
            </p>
          ) : timezoneError ? (
            <p className="text-xs text-destructive">{timezoneError}</p>
          ) : null}

          <Textarea
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
            data-testid="book-appointment-note"
            className="min-h-14 text-sm"
          />

          {dstError ? (
            <p
              className="text-xs text-destructive"
              data-testid="book-appointment-dst-error"
            >
              {dstError}
            </p>
          ) : null}

          {conflictLabel ? (
            <p
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
              data-testid="book-appointment-overlap-warning"
            >
              {conflictLabel}
            </p>
          ) : null}

          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            onClick={submit}
            data-testid="book-appointment-submit"
          >
            {pending ? "Booking…" : "Book appointment"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
