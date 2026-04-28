"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

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
  deleteSequenceStep,
  updateSequence,
  upsertSequenceStep,
  type SequenceWithSteps,
} from "../../actions";

// ---------------------------------------------------------------------------
// Delay input — number + unit dropdown.
//
// Storage is always minutes (matches `sequence_steps.delay_after_previous_minutes`).
// The unit dropdown is a display convenience so authors can pick "3 days"
// instead of typing "4320" and hoping they got the conversion right.
//
// On load, we infer the "most natural" unit — the largest one that yields
// an integer amount. E.g. 10080 min → (1, weeks); 129600 → (3, months);
// 90 → (90, minutes) since no larger unit divides it cleanly.
// ---------------------------------------------------------------------------

type DelayUnit = "minutes" | "hours" | "days" | "weeks" | "months";

const MIN_PER_UNIT: Record<DelayUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10080,
  months: 43200, // 30-day month; matches our 90-day "quarterly" = 3 months
};

function splitDelay(minutes: number): { amount: number; unit: DelayUnit } {
  if (minutes === 0) return { amount: 0, unit: "minutes" };
  const descending: DelayUnit[] = ["months", "weeks", "days", "hours", "minutes"];
  for (const unit of descending) {
    const per = MIN_PER_UNIT[unit];
    if (minutes % per === 0) return { amount: minutes / per, unit };
  }
  return { amount: minutes, unit: "minutes" };
}

function toMinutes(amount: number, unit: DelayUnit): number {
  return Math.round(amount * MIN_PER_UNIT[unit]);
}

function DelayInput({
  value,
  onChange,
  autoFocus = false,
}: {
  value: number; // minutes
  onChange: (minutes: number) => void;
  autoFocus?: boolean;
}) {
  const initial = splitDelay(value);
  const [amount, setAmount] = useState<number>(initial.amount);
  const [unit, setUnit] = useState<DelayUnit>(initial.unit);

  const apply = (nextAmount: number, nextUnit: DelayUnit) => {
    const clamped = Math.max(0, nextAmount);
    setAmount(clamped);
    setUnit(nextUnit);
    onChange(toMinutes(clamped, nextUnit));
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={0}
        step={1}
        value={amount}
        autoFocus={autoFocus}
        onChange={(e) => apply(Number(e.target.value) || 0, unit)}
        className="w-24"
      />
      <select
        value={unit}
        onChange={(e) => apply(amount, e.target.value as DelayUnit)}
        className="border-input rounded-md border px-2 py-1.5 text-sm"
      >
        <option value="minutes">minutes</option>
        <option value="hours">hours</option>
        <option value="days">days</option>
        <option value="weeks">weeks</option>
        <option value="months">months</option>
      </select>
      <span className="text-muted-foreground text-xs">
        after previous step
      </span>
    </div>
  );
}

/**
 * Inline vertical editor. One form for sequence meta, stacked step
 * editors below. Each step has its own save — simpler than a full-form
 * state machine for V1. Adding a step creates a row at step_index =
 * existing.length; deleting reorders via a best-effort resequence on
 * save (V1: no drag-drop, explicit up/down buttons if needed later).
 */
export function SequenceEditor({
  sequence,
  initialImpact,
}: {
  sequence: SequenceWithSteps;
  initialImpact: { total_enrolled: number; scheduled_next_7d: number };
}) {
  const router = useRouter();
  const [name, setName] = useState(sequence.name);
  const [description, setDescription] = useState(sequence.description ?? "");
  const [appendOptOut, setAppendOptOut] = useState(sequence.append_opt_out);
  const [active, setActive] = useState(sequence.active);
  const [pending, startTransition] = useTransition();

  const onSaveMeta = () => {
    // Show the impact modal for any meta edit that affects enrolled leads.
    // Template-body edits on individual steps live-read, so the modal is
    // most relevant for active / description changes — but we show it
    // for any save when enrollments exist.
    const proceed = confirmImpact(initialImpact);
    if (!proceed) return;
    startTransition(async () => {
      await callAction(
        updateSequence(sequence.id, {
          name,
          description: description.trim() || null,
          append_opt_out: appendOptOut,
          active,
        }),
        {
          successMessage: "Sequence saved",
          fallbackMessage: "Could not save sequence",
        },
      );
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => router.push("/sequences")}>
          Back to list
        </Button>
      </div>

      <section className="flex max-w-2xl flex-col gap-4 rounded-md border p-4">
        <h2 className="font-semibold">Sequence details</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span>Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Description</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={appendOptOut}
            onChange={(e) => setAppendOptOut(e.target.checked)}
          />
          <span>
            Auto-append opt-out phrase (rotates among 5 variants at send time)
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          <span>Active — new enrollments can start</span>
        </label>
        <div>
          <Button onClick={onSaveMeta} disabled={pending}>
            Save
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Steps</h2>
          <AddStepButton sequenceId={sequence.id} nextIndex={sequence.steps.length} />
        </div>
        {sequence.steps.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed p-6 text-sm">
            No steps yet. Click &ldquo;Add step&rdquo; to author the first one.
          </div>
        ) : (
          sequence.steps.map((step) => (
            <StepEditor
              key={step.id}
              sequenceId={sequence.id}
              step={step}
              impact={initialImpact}
            />
          ))
        )}
      </section>
    </div>
  );
}

function AddStepButton({
  sequenceId,
  nextIndex,
}: {
  sequenceId: string;
  nextIndex: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // Sensible defaults for a brand-new step. First step fires immediately;
  // subsequent steps default to +24h (a common first nudge cadence). The
  // author can change either in the modal before committing.
  const defaultDelay = nextIndex === 0 ? 0 : 1440;
  const [delayMin, setDelayMin] = useState(defaultDelay);
  const [actionType, setActionType] = useState<"send_sms" | "change_status">(
    "send_sms",
  );
  const [templateBody, setTemplateBody] = useState("");
  const [targetStatus, setTargetStatus] = useState("");

  const resetForm = () => {
    setDelayMin(defaultDelay);
    setActionType("send_sms");
    setTemplateBody("");
    setTargetStatus("");
  };

  const onOpenChange = (next: boolean) => {
    if (!next) resetForm();
    setOpen(next);
  };

  const onSave = () => {
    startTransition(async () => {
      const r = await callAction(
        upsertSequenceStep({
          sequence_id: sequenceId,
          step_index: nextIndex,
          delay_after_previous_minutes: delayMin,
          action_type: actionType,
          template_body: actionType === "send_sms" ? templateBody : null,
          target_status: actionType === "change_status" ? targetStatus : null,
        }),
        {
          successMessage: "Step added",
          fallbackMessage: "Could not add step",
        },
      );
      if (r.ok) {
        onOpenChange(false);
        router.refresh();
      }
    });
  };

  // Disable save when the action's required field is missing.
  const canSave =
    actionType === "send_sms"
      ? templateBody.trim().length > 0
      : targetStatus.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Add step
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add step {nextIndex + 1}</DialogTitle>
          <DialogDescription>
            Step fires after the delay elapses from the previous step&rsquo;s
            run time (or enrollment time, for step 1). Templates are
            live-read on every fire.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
            <div className="flex flex-1 flex-col gap-1 text-sm">
              <span className="font-medium">Delay</span>
              <DelayInput value={delayMin} onChange={setDelayMin} autoFocus />
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Action</span>
              <select
                value={actionType}
                onChange={(e) =>
                  setActionType(
                    e.target.value as "send_sms" | "change_status",
                  )
                }
                className="border-input rounded-md border px-2 py-1.5 text-sm"
              >
                <option value="send_sms">send_sms</option>
                <option value="change_status">change_status</option>
              </select>
            </label>
          </div>

          {actionType === "send_sms" ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Message body</span>
              <textarea
                value={templateBody}
                onChange={(e) => setTemplateBody(e.target.value)}
                rows={4}
                className="border-input rounded-md border px-2 py-1.5 font-mono text-sm"
                placeholder="Hi {{first_name}}, cash offer on {{property_address}}?"
              />
              <span className="text-muted-foreground text-xs">
                Variables: first_name, last_name, property_address, city,
                state, property_zip, market, my_first_name, company_name,
                opt_out. Wrap with <code>{"{{#if var}}…{{/if}}"}</code> to
                skip a phrase when a value is missing.
              </span>
            </label>
          ) : (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Target status</span>
              <select
                value={targetStatus}
                onChange={(e) => setTargetStatus(e.target.value)}
                className="border-input rounded-md border px-2 py-1.5 text-sm"
              >
                <option value="">— select —</option>
                <option value="new_lead">new_lead</option>
                <option value="contacted">contacted</option>
                <option value="interested">interested</option>
                <option value="offer_sent">offer_sent</option>
                <option value="offer_declined">offer_declined</option>
                <option value="under_contract">under_contract</option>
                <option value="closed">closed</option>
                <option value="dead">dead</option>
              </select>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={onSave} disabled={pending || !canSave}>
            Add step
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepEditor({
  sequenceId,
  step,
  impact,
}: {
  sequenceId: string;
  step: SequenceWithSteps["steps"][number];
  impact: { total_enrolled: number; scheduled_next_7d: number };
}) {
  const router = useRouter();
  const [delayMin, setDelayMin] = useState(step.delay_after_previous_minutes);
  const [actionType, setActionType] = useState(step.action_type);
  const [templateBody, setTemplateBody] = useState(step.template_body ?? "");
  const [targetStatus, setTargetStatus] = useState(step.target_status ?? "");
  const [pending, startTransition] = useTransition();

  const onSave = () => {
    if (!confirmImpact(impact)) return;
    startTransition(async () => {
      const r = await callAction(
        upsertSequenceStep({
          id: step.id,
          sequence_id: sequenceId,
          step_index: step.step_index,
          delay_after_previous_minutes: delayMin,
          action_type: actionType,
          template_body: actionType === "send_sms" ? templateBody : null,
          target_status: actionType === "change_status" ? targetStatus : null,
        }),
        {
          successMessage: "Step saved",
          fallbackMessage: "Could not save step",
        },
      );
      if (r.ok) router.refresh();
    });
  };

  const onDelete = () => {
    if (!window.confirm(`Delete step ${step.step_index + 1}?`)) return;
    startTransition(async () => {
      const r = await callAction(
        deleteSequenceStep(step.id, sequenceId),
        {
          successMessage: "Step deleted",
          fallbackMessage: "Could not delete step",
        },
      );
      if (r.ok) router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Step {step.step_index + 1}
        </h3>
        <Button variant="ghost" size="sm" onClick={onDelete} disabled={pending}>
          Delete
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Delay</span>
          <DelayInput value={delayMin} onChange={setDelayMin} />
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Action</span>
          <select
            value={actionType}
            onChange={(e) =>
              setActionType(e.target.value as "send_sms" | "change_status")
            }
            className="border-input rounded-md border px-2 py-1.5 text-sm"
          >
            <option value="send_sms">send_sms</option>
            <option value="change_status">change_status</option>
          </select>
        </label>
      </div>

      {actionType === "send_sms" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Message body</span>
          <textarea
            value={templateBody}
            onChange={(e) => setTemplateBody(e.target.value)}
            rows={4}
            className="border-input rounded-md border px-2 py-1.5 font-mono text-sm"
            placeholder="Hi {{first_name}}, cash offer on {{property_address}}?"
          />
          <span className="text-muted-foreground text-xs">
            Variables: first_name, last_name, property_address, city, state,
            property_zip, market, my_first_name, company_name, opt_out. Wrap
            with <code>{"{{#if var}}…{{/if}}"}</code> to skip a phrase when a
            value is missing.
          </span>
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Target status</span>
          <select
            value={targetStatus}
            onChange={(e) => setTargetStatus(e.target.value)}
            className="border-input rounded-md border px-2 py-1.5 text-sm"
          >
            <option value="">— select —</option>
            <option value="new_lead">new_lead</option>
            <option value="contacted">contacted</option>
            <option value="interested">interested</option>
            <option value="offer_sent">offer_sent</option>
            <option value="offer_declined">offer_declined</option>
            <option value="under_contract">under_contract</option>
            <option value="closed">closed</option>
            <option value="dead">dead</option>
          </select>
        </label>
      )}

      <div>
        <Button onClick={onSave} disabled={pending}>
          Save step
        </Button>
      </div>
    </div>
  );
}

function confirmImpact(impact: {
  total_enrolled: number;
  scheduled_next_7d: number;
}): boolean {
  if (impact.total_enrolled === 0) return true;
  const lines = [
    `${impact.total_enrolled} lead${impact.total_enrolled === 1 ? "" : "s"} enrolled.`,
    `${impact.scheduled_next_7d} scheduled to fire in the next 7 days.`,
    "",
    "Templates are live-read — edits take effect on the next fire.",
    "",
    "Proceed?",
  ];
  return window.confirm(lines.join("\n"));
}

