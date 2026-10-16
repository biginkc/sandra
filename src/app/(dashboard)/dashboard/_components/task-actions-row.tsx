"use client";

import { CheckIcon } from "lucide-react";
import { useTransition } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { completeTaskAction } from "../../tasks/actions";

export type TaskActionChange = { kind: "completed"; taskId: string };

type Props = {
  taskId: string;
  /** Called only after the server confirms the task mutation. */
  onChanged?: (change: TaskActionChange) => void;
};

/**
 * Inline Done control on each TasksPanel row. Server actions
 * trigger revalidation of /dashboard, so the panel re-renders without
 * the completed task naturally on the next router pass.
 */
export function TaskActionsRow({ taskId, onChanged }: Props) {
  const [pending, startTransition] = useTransition();

  function complete() {
    startTransition(async () => {
      const result = await completeTaskAction(taskId);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      onChanged?.({ kind: "completed", taskId });
    });
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:justify-end">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={complete}
        data-testid={`task-done-${taskId}`}
        className="min-h-11 px-3 text-xs"
      >
        <CheckIcon className="mr-1 size-3.5" />
        Done
      </Button>
    </div>
  );
}
