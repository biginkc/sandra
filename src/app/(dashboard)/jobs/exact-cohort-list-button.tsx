"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/errors/call-action";

import { createExactCohortList } from "./actions";

type Props = {
  jobId: string;
  defaultName: string;
  propertyCount?: number;
};

/**
 * Creates a reusable, exact list from a terminal skip-trace job. The server
 * action re-checks ownership and DNC state; this control never launches
 * skip-trace or queues campaign messages.
 */
export function ExactCohortListButton({
  jobId,
  defaultName,
  propertyCount,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;

    startTransition(async () => {
      const result = await callAction(
        createExactCohortList({ jobId, name: trimmed }),
        {
          fallbackMessage: "Could not create the exact cohort list",
        },
      );
      if (!result.ok) return;

      const excluded = result.data.dncExcludedCount;
      const complianceLockedExcluded = result.data.complianceLockedExcludedCount;
      const traceExcluded = result.data.traceExcludedCount;
      toast.success(
        `${result.data.memberCount.toLocaleString()} properties saved${
          excluded > 0 ? ` · ${excluded.toLocaleString()} DNC exclusions` : ""
        }${complianceLockedExcluded > 0 ? ` · ${complianceLockedExcluded.toLocaleString()} compliance-locked import rows excluded` : ""}${
          traceExcluded > 0
            ? ` · ${traceExcluded.toLocaleString()} trace rows excluded`
            : ""
        }. Use this list in the campaign audience filter.`,
      );
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={pending || propertyCount === 0}
      >
        Create exact cohort list
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create exact cohort list</DialogTitle>
            <DialogDescription>
              {propertyCount === undefined ? "This will reuse or create a named list from the successful and duplicate persisted CSV import records." : `This will reuse or create a named list from up to ${propertyCount.toLocaleString()} persisted job properties. Failed trace rows are left out;`} {" "}Sandra re-checks organization ownership,
              live prospect records, and DNC locks immediately before writing.
              It does not send messages.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`exact-cohort-list-name-${jobId}`}>List name</Label>
            <Input
              id={`exact-cohort-list-name-${jobId}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              disabled={pending}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || name.trim().length === 0}
            >
              {pending ? "Saving…" : "Save exact list"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
