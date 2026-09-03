"use client";

import { CheckIcon, ChevronDownIcon, UserIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { callAction } from "@/lib/errors/call-action";
import {
  teamMemberPrimaryLabel,
  teamMemberSecondaryLabel,
} from "@/lib/auth/team-member";

import {
  listPropertyOrgUsers,
  updateLeadAssignee,
  type TeamMember,
} from "../actions";

type Props = {
  propertyId: string;
  address: string;
  initialAssigneeId: string | null;
  initialAssigneeEmail: string | null;
  currentUserId: string | null;
};

/**
 * Lead-header widget: shows who owns this lead, lets any user pick a
 * new assignee or clear it. Mirrors the status widget's pattern —
 * optimistic update + revert on failure.
 */
export function LeadAssigneeWidget({
  propertyId,
  address,
  initialAssigneeId,
  initialAssigneeEmail,
  currentUserId,
}: Props) {
  const router = useRouter();
  const [assigneeId, setAssigneeId] = useState<string | null>(
    initialAssigneeId,
  );
  const [assigneeEmail, setAssigneeEmail] = useState<string | null>(
    initialAssigneeEmail,
  );
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [pending, startTransition] = useTransition();

  const loadMembers = () => {
    if (loaded || loading) return;
    setLoading(true);
    listPropertyOrgUsers(propertyId)
      .then((result) => {
        if (result.ok) {
          setMembers(
            result.data.filter(
              (member) =>
                member.isActive !== false &&
                (member.displayName || member.email),
            ),
          );
          setLoaded(true);
          setLoadError(false);
        } else {
          setLoadError(true);
        }
      })
      .finally(() => setLoading(false));
  };

  const change = (nextId: string | null) => {
    if (nextId === assigneeId || pending) return;
    const previousId = assigneeId;
    const previousEmail = assigneeEmail;
    const nextMember = nextId ? members.find((m) => m.id === nextId) : null;
    const nextEmail = nextMember?.email ?? null;

    // optimistic
    setAssigneeId(nextId);
    setAssigneeEmail(nextEmail);

    startTransition(async () => {
      const result = await callAction(updateLeadAssignee(propertyId, nextId), {
        successMessage: nextId
          ? `Assigned ${address} to ${nextMember ? teamMemberPrimaryLabel(nextMember, currentUserId) : "teammate"}`
          : `Unassigned ${address}`,
        fallbackMessage: `Could not update assignee`,
      });
      if (!result.ok) {
        setAssigneeId(previousId);
        setAssigneeEmail(previousEmail);
      } else {
        router.refresh();
      }
    });
  };

  // Pretty label for the trigger button.
  const selectedMember = members.find((member) => member.id === assigneeId);
  const label = !assigneeId
    ? "Unassigned"
    : selectedMember
      ? `Assigned: ${teamMemberPrimaryLabel(selectedMember, currentUserId)}`
      : loading
        ? "Loading assignee…"
        : `Assigned: ${assigneeEmail ?? "Name not set"}`;

  return (
    <DropdownMenu onOpenChange={(open) => open && loadMembers()}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            aria-label={`Change assignee. Current owner: ${label}`}
          >
            <UserIcon className="mr-1 size-3.5" />
            <span>{label}</span>
            <ChevronDownIcon className="ml-1 size-3.5" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-80 overflow-auto">
        {loading && <DropdownMenuItem disabled>Loading team…</DropdownMenuItem>}
        {loadError && (
          <DropdownMenuItem disabled>
            Team members could not be loaded.
          </DropdownMenuItem>
        )}
        {loaded && members.length === 0 && (
          <DropdownMenuItem disabled>No team members found.</DropdownMenuItem>
        )}
        {currentUserId &&
          loaded &&
          members.some((m) => m.id === currentUserId) && (
            <>
              <DropdownMenuItem
                onClick={() => change(currentUserId)}
                className="flex items-center justify-between gap-4"
              >
                <span>
                  {teamMemberPrimaryLabel(
                    members.find((m) => m.id === currentUserId)!,
                    currentUserId,
                  )}
                </span>
                {assigneeId === currentUserId ? (
                  <CheckIcon className="size-4" />
                ) : null}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
        {loaded &&
          members
            .filter((m) => m.id !== currentUserId)
            .map((m) => (
              <DropdownMenuItem
                key={m.id}
                onClick={() => change(m.id)}
                className="flex items-center justify-between gap-4"
              >
                <span className="flex min-w-0 flex-col">
                  <span>{teamMemberPrimaryLabel(m, currentUserId)}</span>
                  {teamMemberSecondaryLabel(m) ? (
                    <span className="text-muted-foreground text-xs">
                      {teamMemberSecondaryLabel(m)}
                    </span>
                  ) : null}
                </span>
                {m.id === assigneeId ? <CheckIcon className="size-4" /> : null}
              </DropdownMenuItem>
            ))}
        {loaded && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => change(null)}
              className="flex items-center justify-between gap-4"
            >
              <span className="text-muted-foreground">Unassign</span>
              {assigneeId === null ? <CheckIcon className="size-4" /> : null}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
