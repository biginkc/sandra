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
  listOrgUsers,
  updateLeadAssignee,
  type TeamMember,
} from "../leads/actions";

type Props = {
  propertyId: string;
  initialAssigneeId: string | null;
  initialAssigneeEmail: string | null;
  currentUserId: string | null;
};

/**
 * Cockpit side-panel assignee control. Trimmed-down version of the
 * lead-detail `LeadAssigneeWidget`: same dropdown pattern, same server
 * action, but no address-bound copy and no surrounding context.
 *
 * Renders a dropdown trigger showing the current assignment state, with
 * options to pick yourself, a teammate, or unassign.
 */
export function AssignDropdown({
  propertyId,
  initialAssigneeId,
  initialAssigneeEmail,
  currentUserId,
}: Props) {
  const resetKey = [
    propertyId,
    initialAssigneeId ?? "unassigned",
    initialAssigneeEmail ?? "no-email",
  ].join(":");

  return (
    <AssignDropdownContent
      key={resetKey}
      propertyId={propertyId}
      initialAssigneeId={initialAssigneeId}
      initialAssigneeEmail={initialAssigneeEmail}
      currentUserId={currentUserId}
    />
  );
}

function AssignDropdownContent({
  propertyId,
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const loadMembers = () => {
    if (loaded || loading) return;
    setLoading(true);
    setLoadError(null);
    listOrgUsers()
      .then((result) => {
        if (result.ok) {
          setMembers(result.data);
          setLoaded(true);
        } else {
          setLoadError("Could not load team members.");
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

    // Optimistic update.
    setAssigneeId(nextId);
    setAssigneeEmail(nextEmail);

    startTransition(async () => {
      const result = await callAction(updateLeadAssignee(propertyId, nextId), {
        successMessage: nextId
          ? `Assigned to ${nextMember ? teamMemberPrimaryLabel(nextMember, currentUserId) : "teammate"}`
          : "Owner removed",
        fallbackMessage: "Could not update assignee",
      });
      if (!result.ok) {
        setAssigneeId(previousId);
        setAssigneeEmail(previousEmail);
      } else {
        router.refresh();
      }
    });
  };

  const selectedMember = members.find((member) => member.id === assigneeId);
  const label = !assigneeId
    ? "No owner"
    : selectedMember
      ? `Assigned: ${teamMemberPrimaryLabel(selectedMember, currentUserId)}`
      : loading
        ? "Loading assignee…"
        : `Assigned: ${assigneeEmail ?? "Name not set"}`;
  const hasSelfOption = Boolean(
    currentUserId && loaded && members.some((m) => m.id === currentUserId),
  );

  return (
    <DropdownMenu onOpenChange={(open) => open && loadMembers()}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            disabled={pending}
            aria-label="Change assignee"
            data-testid="assign-dropdown-trigger"
          >
            <UserIcon className="mr-1 size-3.5" />
            <span>{label}</span>
            <ChevronDownIcon className="ml-1 size-3.5" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="max-h-80 overflow-auto">
        {loading && <DropdownMenuItem disabled>Loading team…</DropdownMenuItem>}
        {loadError && <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>}
        {loaded && members.length === 0 && !hasSelfOption && (
          <DropdownMenuItem disabled>No team members found.</DropdownMenuItem>
        )}
        {hasSelfOption && currentUserId && (
          <>
            <DropdownMenuItem
              onClick={() => change(currentUserId)}
              className="min-h-11 items-center justify-between gap-4"
              data-testid="assign-dropdown-me"
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
                className="min-h-11 items-center justify-between gap-4"
                data-testid={`assign-dropdown-user-${m.id}`}
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
              className="min-h-11 items-center justify-between gap-4"
              data-testid="assign-dropdown-unassign"
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
