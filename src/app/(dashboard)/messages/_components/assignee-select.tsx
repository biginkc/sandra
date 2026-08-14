"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import {
  listBookingAssignees,
  type TeamMember,
} from "@/components/appointments/book-appointment-action";

type Props = {
  /** Selected assignee id; null = unassigned. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** auth.users.id of the viewer; used to render "Me" + as the default. */
  currentUserId: string | null;
  /** Booking context (property or contact this appointment links to) —
   *  scopes the picker to the SAME org `bookAppointment` will book into.
   *  Both omitted means a personal block, scoped to the caller's own
   *  single active org membership. */
  propertyId?: string;
  contactId?: string;
  /** Disabled while the parent form is in flight. */
  disabled?: boolean;
  className?: string;
};

/**
 * Inline assignee picker for the booking popover. Loads org members
 * lazily on first mount (popover open) — matches the AssignDropdown
 * loading pattern but rendered as a native <select> so it fits the
 * popover's compact form aesthetic alongside the date input.
 *
 * Scoped via `listBookingAssignees` (Codex round 2) to exactly the org
 * this booking will resolve into, active members only — NOT the broader
 * `listOrgUsers` (every org the caller has ever belonged to, active or
 * not, every member active or not).
 *
 * Self-render is "Me" rather than the email — consistent with how
 * AssignDropdown shows the same property.
 */
export function AssigneeSelect({
  value,
  onChange,
  currentUserId,
  propertyId,
  contactId,
  disabled,
  className,
}: Props) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listBookingAssignees({ propertyId, contactId })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setMembers(result.data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId, contactId]);

  const others = members.filter((m) => m.id !== currentUserId);
  const showMe = currentUserId !== null;

  return (
    <select
      data-testid="assignee-select"
      value={value ?? ""}
      disabled={disabled || loading}
      onChange={(e) => {
        const next = e.target.value;
        onChange(next === "" ? null : next);
      }}
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {showMe ? <option value={currentUserId!}>Me</option> : null}
      {others.map((m) => (
        <option key={m.id} value={m.id}>
          {m.email}
        </option>
      ))}
    </select>
  );
}
