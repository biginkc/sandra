"use client";

import { CheckIcon, ChevronDownIcon, UserIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

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
  listOrgUsers,
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
  const [assigneeId, setAssigneeId] = useState<string | null>(initialAssigneeId);
  const [assigneeEmail, setAssigneeEmail] = useState<string | null>(
    initialAssigneeEmail,
  );
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  // Load members lazily the first time the dropdown opens.
  const loadMembers = () => {
    if (loaded || loading) return;
    setLoading(true);
    listOrgUsers()
      .then((result) => {
        if (result.ok) {
          setMembers(result.data);
          setLoaded(true);
        }
      })
      .finally(() => setLoading(false));
  };

  const change = (nextId: string | null) => {
    if (nextId === assigneeId || pending) return;
    const previousId = assigneeId;
    const previousEmail = assigneeEmail;
    const nextEmail = nextId
      ? members.find((m) => m.id === nextId)?.email ?? null
      : null;

    // optimistic
    setAssigneeId(nextId);
    setAssigneeEmail(nextEmail);

    startTransition(async () => {
      const result = await callAction(
        updateLeadAssignee(propertyId, nextId),
        {
          successMessage: nextId
            ? `Assigned ${address} to ${nextEmail ?? "user"}`
            : `Unassigned ${address}`,
          fallbackMessage: `Could not update assignee`,
        },
      );
      if (!result.ok) {
        setAssigneeId(previousId);
        setAssigneeEmail(previousEmail);
      } else {
        router.refresh();
      }
    });
  };

  // Pretty label for the trigger button.
  const label = assigneeEmail
    ? assigneeId === currentUserId
      ? "Assigned: me"
      : `Assigned: ${shortenEmail(assigneeEmail)}`
    : "Unassigned";

  return (
    <DropdownMenu onOpenChange={(open) => open && loadMembers()}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            aria-label="Change assignee"
          >
            <UserIcon className="mr-1 size-3.5" />
            <span>{label}</span>
            <ChevronDownIcon className="ml-1 size-3.5" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-80 overflow-auto">
        {loading && (
          <DropdownMenuItem disabled>Loading team…</DropdownMenuItem>
        )}
        {loaded && members.length === 0 && (
          <DropdownMenuItem disabled>No team members found.</DropdownMenuItem>
        )}
        {currentUserId && loaded && members.some((m) => m.id === currentUserId) && (
          <>
            <DropdownMenuItem
              onClick={() => change(currentUserId)}
              className="flex items-center justify-between gap-4"
            >
              <span>Me</span>
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
                <span>{m.email}</span>
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

function shortenEmail(email: string): string {
  // "jarrad@bmhgroupkc.com" → "jarrad"; keeps full email if no @.
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
