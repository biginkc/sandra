"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";

import {
  deleteSequenceStep,
  getImpactAction,
  updateSequence,
  upsertSequenceStep,
  type SequenceWithSteps,
} from "../../actions";

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{sequence.name}</h1>
          <p className="text-muted-foreground text-sm">
            {initialImpact.total_enrolled > 0
              ? `${initialImpact.total_enrolled} lead${initialImpact.total_enrolled === 1 ? "" : "s"} enrolled · ${initialImpact.scheduled_next_7d} due in the next 7 days`
              : "No leads enrolled yet."}
          </p>
        </div>
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
  const [pending, startTransition] = useTransition();
  const onAdd = () => {
    startTransition(async () => {
      const r = await callAction(
        upsertSequenceStep({
          sequence_id: sequenceId,
          step_index: nextIndex,
          delay_after_previous_minutes: nextIndex === 0 ? 0 : 1440,
          action_type: "send_sms",
          template_body: "Hi {{first_name}}, ",
        }),
        {
          successMessage: "Step added",
          fallbackMessage: "Could not add step",
        },
      );
      if (r.ok) router.refresh();
    });
  };
  return (
    <Button variant="outline" onClick={onAdd} disabled={pending}>
      Add step
    </Button>
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

  const humanDelay = describeDelay(delayMin);

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

      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">
            Delay after previous step (minutes)
          </span>
          <Input
            type="number"
            min={0}
            value={delayMin}
            onChange={(e) => setDelayMin(Math.max(0, Number(e.target.value)))}
          />
          <span className="text-muted-foreground text-xs">≈ {humanDelay}</span>
        </label>

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

function describeDelay(minutes: number): string {
  if (minutes === 0) return "fires immediately";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  if (minutes < 43200) return `${(minutes / 1440).toFixed(1)}d`;
  return `${(minutes / 43200).toFixed(1)}mo`;
}
