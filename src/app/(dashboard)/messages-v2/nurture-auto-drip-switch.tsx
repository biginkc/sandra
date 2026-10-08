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

import { NURTURE_DRIP_DEFAULT_NAMES } from "@/lib/ai-responder/nurture-routes";

import { setNurtureAutoDrip, type NurtureDripMap } from "./threshold-actions";

export type NurtureAutoDripState = {
  configId: string;
  enabled: boolean;
  /** Saved route -> drip mapping. */
  drips: NurtureDripMap;
  /** Active drips the owner can pick from. */
  sequences: Array<{ id: string; name: string }>;
};

const ROUTES: Array<{ key: keyof NurtureDripMap; label: string; defaultName: string }> = [
  { key: "maybeLater", label: "Maybe later (1 to 12 months)", defaultName: NURTURE_DRIP_DEFAULT_NAMES.maybe_later },
  { key: "checkIn60", label: "Check in every 60 days (over a year, no timeframe, unsure)", defaultName: NURTURE_DRIP_DEFAULT_NAMES.check_in_60 },
  { key: "hotBookAppointment", label: "Ready within 30 days (also alerts a person)", defaultName: NURTURE_DRIP_DEFAULT_NAMES.hot_book_appointment },
  { key: "listedNotSelling", label: "Listed, not selling", defaultName: NURTURE_DRIP_DEFAULT_NAMES.listed_not_selling },
];

/** Saved choice, else the drip whose name matches the default EXACTLY, else empty. Owner still has to save. */
function initialDrips(state: NurtureAutoDripState): Record<keyof NurtureDripMap, string> {
  const out = {} as Record<keyof NurtureDripMap, string>;
  for (const r of ROUTES) {
    out[r.key] = state.drips[r.key] ?? state.sequences.find((s) => s.name === r.defaultName)?.id ?? "";
  }
  return out;
}

/**
 * Owner-only switch beside the per-label rules: when on, a nurture outcome that
 * Jev applies automatically also enrols the lead in the drip the owner mapped to
 * its route, but only after the approved nurture reply was sent. Off by default;
 * cannot be turned on until all three routes have a drip. Never picks a drip
 * for the owner (name matches are only pre-selected).
 */
export function NurtureAutoDripSwitch({ state }: { state: NurtureAutoDripState }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(state.enabled);
  const [drips, setDrips] = useState(() => initialDrips(state));

  const allSet = ROUTES.every((r) => drips[r.key] !== "");
  const dripsChanged = ROUTES.some((r) => drips[r.key] !== (state.drips[r.key] ?? ""));
  const changed = enabled !== state.enabled || dripsChanged;
  const canSave = changed && (!enabled || allSet);

  const apply = () => {
    startTransition(async () => {
      const result = await callAction(
        setNurtureAutoDrip({
          configId: state.configId,
          enabled,
          drips: {
            maybeLater: drips.maybeLater || null,
            checkIn60: drips.checkIn60 || null,
            listedNotSelling: drips.listedNotSelling || null,
            hotBookAppointment: drips.hotBookAppointment || null,
          },
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
          setDrips(initialDrips(state));
          setOpen(true);
        }}
      >
        <Badge variant="outline" className="gap-1">
          nurture drip [{state.enabled ? "ON" : "OFF"}]
        </Badge>
      </button>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Nurture auto-drip</DialogTitle>
            <DialogDescription>
              When Jev applies nurture on its own, send the approved nurture reply first, then start the drip for what the seller said.
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

          {ROUTES.map((r) => (
            <label key={r.key} className="flex flex-col gap-1 text-sm">
              {r.label}
              <select
                className="rounded border bg-background px-2 py-1"
                value={drips[r.key]}
                onChange={(e) => setDrips((d) => ({ ...d, [r.key]: e.target.value }))}
                data-testid={`nurture-auto-drip-${r.key}`}
              >
                <option value="">Choose a drip</option>
                {state.sequences.map((sq) => (
                  <option key={sq.id} value={sq.id}>
                    {sq.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            Sellers who say they could sell within 30 days get no nurture reply: a person is alerted and the Book appointment drip starts.
            Anyone enrolled can be stopped from the lead page.
          </p>
          {enabled && !allSet && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              Choose all four drips before turning this on.
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
