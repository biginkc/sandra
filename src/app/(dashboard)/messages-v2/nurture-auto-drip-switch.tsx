"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callAction } from "@/lib/errors/call-action";

import { setNurtureAutoDrip } from "./threshold-actions";

export type NurtureAutoDripState = {
  configId: string;
  enabled: boolean;
  sequenceId: string | null;
  /** Active drips the owner can pick from. */
  sequences: Array<{ id: string; name: string }>;
};

/**
 * Owner-only switch beside the per-label rules: when on, a nurture outcome that
 * Jev applies automatically also enrols the lead in the chosen drip, but only
 * after the approved nurture reply was sent. Off by default. Never picks a
 * drip for the owner.
 */
export function NurtureAutoDripSwitch({ state }: { state: NurtureAutoDripState }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(state.enabled);
  const [sequenceId, setSequenceId] = useState(state.sequenceId ?? "");

  const currentName = state.sequences.find((s) => s.id === state.sequenceId)?.name;
  const changed = enabled !== state.enabled || (enabled && sequenceId !== (state.sequenceId ?? ""));
  const canSave = changed && (!enabled || sequenceId !== "");

  const apply = () => {
    startTransition(async () => {
      const result = await callAction(
        setNurtureAutoDrip({
          configId: state.configId,
          enabled,
          sequenceId: sequenceId || null,
        }),
        { fallbackMessage: "Failed to save" },
      );
      if (result.ok) {
        toast.success("Saved");
        setOpen(false);
        router.refresh();
      }
    });
  };

  return (
    <>
      <button
        type="button"
        aria-label="Edit nurture auto-drip"
        data-testid="edit-nurture-auto-drip"
        className="cursor-pointer rounded-full focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setEnabled(state.enabled);
          setSequenceId(state.sequenceId ?? "");
          setOpen(true);
        }}
      >
        <Badge variant="outline" className="gap-1">
          nurture drip [{state.enabled ? `ON${currentName ? `: ${currentName}` : ""}` : "OFF"}]
        </Badge>
      </button>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Nurture auto-drip</DialogTitle>
            <DialogDescription>
              When Jev applies nurture on its own, send the approved nurture reply first, then start this drip.
              If the reply cannot go out, nothing is enrolled and a person is asked to reply and start the drip.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="flex items-center gap-4" aria-label="Nurture auto-drip">
            <legend className="sr-only">Auto-drip</legend>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="nurture-auto-drip"
                checked={enabled}
                onChange={() => setEnabled(true)}
              />
              On
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="nurture-auto-drip"
                checked={!enabled}
                onChange={() => setEnabled(false)}
              />
              Off
            </label>
          </fieldset>

          <label className="flex flex-col gap-1 text-sm">
            Drip to start
            <select
              className="rounded border bg-background px-2 py-1"
              value={sequenceId}
              onChange={(e) => setSequenceId(e.target.value)}
              data-testid="nurture-auto-drip-sequence"
            >
              <option value="">Choose a drip</option>
              {state.sequences.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {enabled && sequenceId === "" && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              Choose the drip before turning this on.
            </p>
          )}

          <DialogFooter showCloseButton={false}>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={apply} disabled={pending || !canSave} data-testid="apply-nurture-auto-drip">
              {pending ? "Saving…" : changed ? "Save" : "No change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
