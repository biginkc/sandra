"use client";

import {
  CalendarClockIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { completeTaskAction, snoozeTaskAction } from "../../tasks/actions";

export type LeadNextTask = {
  id: string;
  title: string;
  due_at: string;
  type: string;
};

type TaskOperation =
  | { kind: "complete"; taskId: string }
  | { kind: "snooze"; taskId: string; until: string };

type TaskFailure = {
  message: string;
  operation: TaskOperation;
};

const SNOOZE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
];

export function NextActionCard({
  task,
  timezone,
}: {
  task: LeadNextTask | null;
  timezone: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<TaskFailure | null>(null);

  const run = useCallback(
    (operation: TaskOperation) => {
      setFailure(null);
      startTransition(async () => {
        const result =
          operation.kind === "complete"
            ? await completeTaskAction(operation.taskId)
            : await snoozeTaskAction(operation.taskId, operation.until);
        if (!result.ok) {
          setFailure({ message: result.error.message, operation });
          return;
        }
        setFailure(null);
        router.refresh();
      });
    },
    [router],
  );

  const complete = () => run({ kind: "complete", taskId: task!.id });
  const snooze = (days: number) => {
    const until = new Date();
    until.setDate(until.getDate() + days);
    run({ kind: "snooze", taskId: task!.id, until: until.toISOString() });
  };

  if (!task) {
    return (
      <div
        className="border-amber-300 bg-amber-50 rounded-lg border p-4 text-amber-950"
        data-testid="lead-no-next-action"
      >
        <div className="flex items-start gap-3">
          <CalendarClockIcon className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-bold">No next action</div>
            <p className="mt-1 text-sm">
              This active lead has no open dated task or appointment.
            </p>
            <a
              href="#set-next-action"
              className="mt-3 inline-flex min-h-11 items-center rounded-md bg-amber-950 px-4 text-sm font-semibold text-white sm:min-h-8"
            >
              Set one
            </a>
          </div>
        </div>
      </div>
    );
  }

  const isAppointment = task.type === "appointment";

  return (
    <div
      className="border-border bg-card rounded-lg border p-4"
      data-testid="lead-next-action"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-muted-foreground text-[10px] font-black uppercase tracking-[0.14em]">
            Next dated action
          </div>
          <div className="text-foreground mt-1 truncate text-base font-bold">
            {task.title}
          </div>
          <div className="text-muted-foreground mt-0.5 text-sm">
            {formatDueAt(task.due_at, timezone)} · {formatTaskType(task.type)}
          </div>
        </div>
        {isAppointment ? (
          <a
            href="#lead-appointments"
            className="border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex min-h-11 items-center justify-center rounded-md border px-3 text-sm font-medium sm:min-h-8"
          >
            View appointment
          </a>
        ) : (
          <div className="flex min-h-11 items-center gap-2 sm:min-h-0">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={complete}
              data-testid={`lead-task-done-${task.id}`}
              className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
            >
              <CheckIcon className="size-3.5" />
              Done
            </Button>
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    data-testid={`lead-task-snooze-${task.id}`}
                    className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
                  >
                    <ClockIcon className="size-3.5" />
                    Snooze
                    <ChevronDownIcon className="size-3" />
                  </Button>
                }
              />
              <PopoverContent className="w-36 p-1" align="end">
                {SNOOZE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => snooze(preset.days)}
                    disabled={pending}
                    className="hover:bg-muted flex min-h-11 w-full items-center rounded-md px-2 py-1.5 text-left text-xs font-medium disabled:opacity-50 sm:min-h-8"
                    data-testid={`lead-task-snooze-${preset.days}d-${task.id}`}
                  >
                    {preset.label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>
      {!isAppointment && failure?.operation.taskId === task.id ? (
        <div
          className="border-destructive/30 bg-destructive/5 text-destructive mt-3 flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          role="alert"
          data-testid="lead-next-action-failure"
        >
          <span>Task update failed: {failure.message}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => run(failure.operation)}
          >
            <RotateCcwIcon className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function formatDueAt(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatTaskType(type: string): string {
  return type.replaceAll("_", " ");
}
