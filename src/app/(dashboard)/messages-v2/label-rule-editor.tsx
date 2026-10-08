"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
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
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";
import {
  THRESHOLDABLE_OUTCOMES,
  type ThresholdableOutcome,
} from "@/lib/sms-classification/thresholds";

import { isNeverAuto, NEVER_AUTO_NOTE, NEW_LEAD_AUTO_NOTE } from "./rule-policy";
import { formatConfidence, formatRuleText, parseConfidenceInput } from "./rule-text";
import { setLabelRule } from "./threshold-actions";
import type { ModeBadge } from "./types";

type Rule = NonNullable<ModeBadge["rule"]>;

/** True when the owner can edit this badge: a thresholdable label whose stored rule was read in full. */
export function isEditableBadge(
  badge: ModeBadge,
): badge is ModeBadge & { rule: Rule; label: ThresholdableOutcome } {
  return badge.rule !== undefined && THRESHOLDABLE_OUTCOMES.has(badge.label as ThresholdableOutcome);
}

type Props = {
  orgId: string;
  badge: ModeBadge & { rule: Rule; label: ThresholdableOutcome };
  /** The badge as displayed, e.g. "nurture [AUTO ≥0.95]". */
  text: string;
  className?: string;
};

/**
 * Owner-only editor for one label's rule (on/off and cutoff). Never chooses a
 * value: the cutoff is typed, the switch is explicit, and the confirmation
 * shows the exact rule text that will be saved before anything is written.
 */
export function LabelRuleEditor({ orgId, badge, text, className }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const { rule } = badge;
  const [enabled, setEnabled] = useState<boolean | null>(rule.automationEnabled);
  const [cutoff, setCutoff] = useState(rule.minConfidence === null ? "" : formatConfidence(rule.minConfidence));
  const groupName = useId();
  const neverAuto = isNeverAuto(badge.label);

  const parsed = parseConfidenceInput(cutoff);
  const current =
    rule.minConfidence !== null && rule.automationEnabled !== null
      ? formatRuleText({
          outcome: badge.label,
          minConfidence: rule.minConfidence,
          automationEnabled: rule.automationEnabled,
        })
      : null;
  const next =
    parsed.ok && enabled !== null
      ? formatRuleText({ outcome: badge.label, minConfidence: parsed.value, automationEnabled: enabled })
      : null;
  const unchanged = next !== null && next === current;

  const reset = () => {
    setEnabled(rule.automationEnabled);
    setCutoff(rule.minConfidence === null ? "" : formatConfidence(rule.minConfidence));
  };

  const apply = () => {
    if (!parsed.ok || enabled === null || (neverAuto && enabled)) return;
    startTransition(async () => {
      const result = await callAction(
        setLabelRule({
          orgId,
          outcome: badge.label,
          minConfidence: parsed.value,
          automationEnabled: enabled,
          expectedVersion: rule.version,
        }),
        { fallbackMessage: "Failed to save rule" },
      );
      if (result.ok) {
        toast.success("Rule saved");
        setOpen(false);
        router.refresh();
      }
    });
  };

  return (
    <>
      <button
        type="button"
        aria-label={`Edit rule for ${badge.label}`}
        data-testid={`edit-rule-${badge.label}`}
        className="cursor-pointer rounded-full focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Badge variant="outline" className={className}>
          {text}
        </Badge>
      </button>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Rule for {badge.label}</DialogTitle>
            <DialogDescription>
              Applies to the next inbound text. Every change is recorded with who made it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">Current rule</span>
            <code data-testid="current-rule-text" className="rounded bg-muted px-2 py-1 text-sm">
              {current ?? `${badge.label}: not fully known (set both below)`}
            </code>
          </div>

          <fieldset className="flex items-center gap-4" aria-label={`Automation for ${badge.label}`}>
            <legend className="sr-only">Automation</legend>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name={groupName}
                checked={enabled === true}
                disabled={neverAuto}
                onChange={() => setEnabled(true)}
              />
              On
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name={groupName}
                checked={enabled === false}
                onChange={() => setEnabled(false)}
              />
              Off
            </label>
          </fieldset>
          {neverAuto && (
            <p data-testid="never-auto-note" className="text-xs text-muted-foreground">
              {NEVER_AUTO_NOTE}. Only the cutoff can be set.
            </p>
          )}
          {badge.label === "new_lead" && enabled === true && (
            <p data-testid="new-lead-auto-note" className="text-xs text-amber-700 dark:text-amber-300">
              {NEW_LEAD_AUTO_NOTE}.
            </p>
          )}

          <label className="flex flex-col gap-1 text-sm">
            Native confidence cutoff (0 to 1)
            <Input
              inputMode="decimal"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              aria-invalid={cutoff !== "" && !parsed.ok}
              data-testid="rule-cutoff-input"
            />
          </label>
          {!parsed.ok && cutoff !== "" && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {parsed.reason}
            </p>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">Rule after this change</span>
            <code data-testid="new-rule-text" className="rounded bg-muted px-2 py-1 text-sm">
              {next ?? "Choose On or Off and type a cutoff."}
            </code>
          </div>

          {(badge.mode === "SHADOW" || badge.mode === "LEGACY") && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              The classifier is not in automatic mode, so this rule does not take effect until it is.
            </p>
          )}

          <DialogFooter showCloseButton={false}>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={apply} disabled={pending || next === null || unchanged || (neverAuto && enabled === true)} data-testid="apply-rule">
              {pending ? "Saving…" : unchanged ? "No change" : "Apply this rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
