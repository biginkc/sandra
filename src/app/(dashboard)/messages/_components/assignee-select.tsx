"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { listOrgUsers, type TeamMember } from "../../leads/actions";

type Props = {
  /** Selected assignee id; null = unassigned. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** auth.users.id of the viewer; used to render "Me" + as the default. */
  currentUserId: string | null;
  /** Disabled while the parent form is in flight. */
  disabled?: boolean;
  className?: string;
};

/**
 * Inline assignee picker for the dispo popover. Loads org members lazily
 * on first mount (popover open) — matches the AssignDropdown loading
 * pattern but rendered as a native <select> so it fits the popover's
 * compact form aesthetic alongside the date input.
 *
 * Self-render is "Me" rather than the email — consistent with how
 * AssignDropdown shows the same property.
 */
export function AssigneeSelect({
  value,
  onChange,
  currentUserId,
  disabled,
  className,
}: Props) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listOrgUsers()
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
  }, []);

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
