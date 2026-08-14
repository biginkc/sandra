"use client";

import { CheckIcon, ChevronDownIcon, ClockIcon } from "lucide-react";
import { useTransition } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { completeTaskAction, snoozeTaskAction } from "../../tasks/actions";

type Props = {
  taskId: string;
  /** Appointments are rescheduled through the calendar lifecycle (PR 3),
   *  never snoozed — a snooze would move the Sandra window while the
   *  legacy calendar updater rebuilds the Google event at 30 minutes. */
  canSnooze?: boolean;
};

const SNOOZE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
];

/**
 * Inline Done + Snooze controls on each TasksPanel row. Server actions
 * trigger revalidation of /dashboard, so the panel re-renders without
 * the completed / snoozed task naturally on the next router pass.
 */
export function TaskActionsRow({ taskId, canSnooze = true }: Props) {
  const [pending, startTransition] = useTransition();

  function complete() {
    startTransition(async () => {
      const result = await completeTaskAction(taskId);
      if (!result.ok) toast.error(result.error.message);
    });
  }

  function snooze(days: number) {
    const until = new Date();
    until.setDate(until.getDate() + days);
    startTransition(async () => {
      const result = await snoozeTaskAction(taskId, until.toISOString());
      if (!result.ok) toast.error(result.error.message);
    });
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={complete}
        data-testid={`task-done-${taskId}`}
        className="h-7 px-2 text-xs"
      >
        <CheckIcon className="mr-1 size-3.5" />
        Done
      </Button>
      {canSnooze ? (
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              data-testid={`task-snooze-${taskId}`}
              className="h-7 px-2 text-xs"
              aria-label="Snooze task"
            >
              <ClockIcon className="mr-1 size-3.5" />
              Snooze
              <ChevronDownIcon className="ml-1 size-3" />
            </Button>
          }
        />
        <PopoverContent className="w-32 p-1" align="end">
          {SNOOZE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => snooze(preset.days)}
              disabled={pending}
              className="hover:bg-muted flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors disabled:opacity-50"
              data-testid={`task-snooze-${preset.days}d-${taskId}`}
            >
              {preset.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>
      ) : null}
    </div>
  );
}
