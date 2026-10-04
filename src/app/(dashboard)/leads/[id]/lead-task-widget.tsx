"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";
import { teamMemberOptionLabel } from "@/lib/auth/team-member";
import { cn } from "@/lib/utils";

import {
  createLeadTaskAction,
  listPropertyOrgUsers,
  type LeadTaskKind,
  type TeamMember,
} from "../actions";

type Props = {
  propertyId: string;
  address: string;
  currentUserId: string | null;
  initialAssigneeId: string | null;
};

const TASK_LABELS: Record<LeadTaskKind, string> = {
  appointment: "Appointment",
  task: "Task",
};

const MODE_LABELS = { phone: "Phone", in_person: "In person" } as const;
type Mode = keyof typeof MODE_LABELS;
const DURATION_OPTIONS = [15, 30, 45, 60, 90] as const;

export function LeadTaskWidget({
  propertyId,
  address,
  currentUserId,
  initialAssigneeId,
}: Props) {
  const router = useRouter();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [memberLoadError, setMemberLoadError] = useState(false);
  const [taskType, setTaskType] = useState<LeadTaskKind>("appointment");
  const [mode, setMode] = useState<Mode>("phone");
  const [title, setTitle] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<number>(30);
  const [location, setLocation] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>(
    initialAssigneeId ?? currentUserId ?? "",
  );
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    listPropertyOrgUsers(propertyId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          const assignable = result.data.filter(
            (member) =>
              member.isActive !== false && (member.displayName || member.email),
          );
          setMembers(assignable);
          setMemberLoadError(false);
          setAssigneeId((current) =>
            assignable.some((member) => member.id === current)
              ? current
              : assignable.some((member) => member.id === currentUserId)
                ? (currentUserId ?? "")
                : (assignable[0]?.id ?? ""),
          );
        } else {
          setMembers([]);
          setAssigneeId("");
          setMemberLoadError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUserId, initialAssigneeId, propertyId]);

  const needsTitle = taskType === "task";
  const inPerson = taskType === "appointment" && mode === "in_person";
  const canSubmit =
    Boolean(dueAt && assigneeId) &&
    !(needsTitle && !title.trim()) &&
    !pending &&
    !loadingMembers &&
    !memberLoadError;

  const submit = () => {
    if (!canSubmit) return;
    startTransition(async () => {
      const result = await callAction(
        createLeadTaskAction(propertyId, {
          kind: taskType,
          dueAt: new Date(dueAt).toISOString(),
          assigneeId,
          ...(taskType === "task" ? { title: title.trim() } : {}),
          ...(taskType === "appointment"
            ? {
                mode,
                ...(inPerson
                  ? {
                      durationMinutes,
                      ...(location.trim() ? { location: location.trim() } : {}),
                    }
                  : {}),
              }
            : {}),
        }),
        {
          successMessage: `${TASK_LABELS[taskType]} created for ${address}`,
          fallbackMessage: `Could not create ${TASK_LABELS[taskType].toLowerCase()}`,
        },
      );
      if (result.ok) {
        setDueAt("");
        setTitle("");
        setLocation("");
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="lead-task-widget">
      <div
        className="inline-flex w-fit rounded-md border border-[#e5e1df] bg-white p-0.5"
        role="group"
        aria-label="Next step type"
      >
        {(Object.keys(TASK_LABELS) as LeadTaskKind[]).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setTaskType(type)}
            aria-pressed={taskType === type}
            data-testid={`lead-task-type-${type}`}
            data-active={taskType === type || undefined}
            className={cn(
              "rounded px-3 py-1 text-xs font-semibold transition-colors",
              taskType === type
                ? "bg-[#111827] text-white"
                : "text-[#78716c] hover:bg-[#f5f5f4] hover:text-[#1c1917]",
            )}
          >
            {TASK_LABELS[type]}
          </button>
        ))}
      </div>

      {taskType === "appointment" ? (
        <div
          className="inline-flex w-fit rounded-md border border-[#e5e1df] bg-white p-0.5"
          role="group"
          aria-label="Appointment mode"
        >
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              data-testid={`lead-task-mode-${m}`}
              className={cn(
                "rounded px-3 py-1 text-xs font-semibold transition-colors",
                mode === m
                  ? "bg-[#111827] text-white"
                  : "text-[#78716c] hover:bg-[#f5f5f4] hover:text-[#1c1917]",
              )}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      ) : (
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-[#78716c]">
          Title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={pending}
            maxLength={200}
            data-testid="lead-task-title"
            className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm text-[#1c1917] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          />
        </label>
      )}

      {inPerson ? (
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-[#78716c]">
            Duration
            <select
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              disabled={pending}
              data-testid="lead-task-duration"
              className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm text-[#1c1917] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              {DURATION_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} min
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-[#78716c]">
            Location
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              disabled={pending}
              maxLength={500}
              data-testid="lead-task-location"
              className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm text-[#1c1917] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            />
          </label>
        </div>
      ) : null}

      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-[#78716c]">
          Due
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            disabled={pending}
            data-testid="lead-task-due-at"
            className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm text-[#1c1917] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-[#78716c]">
          Owner
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            disabled={pending || loadingMembers}
            data-testid="lead-task-assignee"
            className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm text-[#1c1917] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <option value="" disabled>
              Choose owner
            </option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {teamMemberOptionLabel(member, currentUserId)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            onClick={submit}
            data-testid="lead-task-submit"
          >
            {taskType === "appointment" ? "Create appointment" : "Create task"}
          </Button>
        </div>
      </div>
      {memberLoadError ? (
        <p className="text-destructive text-xs" role="alert">
          Team members could not be loaded. Refresh before assigning this next step.
        </p>
      ) : null}
    </div>
  );
}
