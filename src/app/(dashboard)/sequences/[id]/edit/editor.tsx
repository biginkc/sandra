"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";
import {
  PROPERTY_STATUS_LABELS,
  SEQUENCE_ACTION_LABELS,
  systemLabel,
} from "@/lib/presentation/system-labels";

import { type TemplateRow } from "@/app/(dashboard)/templates/actions";

import {
  replaceSequenceSteps,
  type SequenceStepInput,
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
  const descending: DelayUnit[] = [
    "months",
    "weeks",
    "days",
    "hours",
    "minutes",
  ];
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
        aria-label="Delay amount"
        type="number"
        min={0}
        step={1}
        value={amount}
        autoFocus={autoFocus}
        onChange={(e) => apply(Number(e.target.value) || 0, unit)}
        className="w-24"
      />
      <select
        aria-label="Delay unit"
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
      <span className="text-muted-foreground text-xs">after previous step</span>
    </div>
  );
}

type DraftStep = SequenceStepInput & { key: string };

function draftFromStep(step: SequenceWithSteps["steps"][number]): DraftStep {
  return { ...step, key: step.id };
}

let draftCounter = 0;
function blankStep(index: number): DraftStep {
  return {
    key: `new-${++draftCounter}`, step_index: index,
    delay_after_previous_minutes: index === 0 ? 0 : 1440,
    action_type: "send_sms", template_body: "", template_id: null,
    template_category: null, target_status: null,
  };
}

export function SequenceEditor({ sequence, initialImpact, templates, isNew = false }: {
  sequence: SequenceWithSteps;
  initialImpact: { total_enrolled: number; scheduled_next_7d: number };
  templates: TemplateRow[];
  isNew?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(sequence.name);
  const [description, setDescription] = useState(sequence.description ?? "");
  const [steps, setSteps] = useState<DraftStep[]>(() =>
    isNew && sequence.steps.length === 0 ? [blankStep(0)] : sequence.steps.map(draftFromStep));
  const [pending, startTransition] = useTransition();

  const patchStep = (key: string, patch: Partial<DraftStep>) =>
    setSteps((old) => old.map((step) => step.key === key ? { ...step, ...patch } : step));
  const removeStep = (key: string) =>
    setSteps((old) => old.filter((step) => step.key !== key)
      .map((step, step_index) => ({ ...step, step_index })));
  const moveStep = (index: number, delta: number) => setSteps((old) => {
    const target = index + delta;
    if (target < 0 || target >= old.length) return old;
    const next = [...old];
    [next[index], next[target]] = [next[target], next[index]];
    return next.map((step, step_index) => ({ ...step, step_index }));
  });
  const valid = name.trim().length > 0 && steps.every((step) => {
    if (step.action_type === "send_sms") {
      const body = !step.template_id && !step.template_category ? step.template_body?.trim() : null;
      return Number(Boolean(body)) + Number(Boolean(step.template_id)) +
        Number(Boolean(step.template_category?.trim())) === 1 && !step.target_status;
    }
    return step.action_type === "change_status" && Boolean(step.target_status?.trim()) &&
      !step.template_body?.trim() && !step.template_id && !step.template_category?.trim();
  });

  const onSave = () => {
    if (!valid) return;
    if (initialImpact.total_enrolled > 0 && !window.confirm(
      `${initialImpact.total_enrolled} lead${initialImpact.total_enrolled === 1 ? "" : "s"} enrolled.\n` +
      `${initialImpact.scheduled_next_7d} scheduled in the next 7 days.\n` +
      "Changes to this drip take effect on the next step. Save all changes?")) return;
    const savedKeys = steps.map((step) => step.key);
    startTransition(async () => {
      const result = await callAction(replaceSequenceSteps({
        sequenceId: sequence.id, name, description: description.trim() || null,
        steps: steps.map((step, step_index) => ({
          id: step.id, step_index, delay_after_previous_minutes: step.delay_after_previous_minutes,
          action_type: step.action_type,
          template_body: step.action_type === "send_sms" && !step.template_id && !step.template_category
            ? step.template_body?.trim() || null : null,
          template_id: step.action_type === "send_sms" ? step.template_id : null,
          template_category: step.action_type === "send_sms" ? step.template_category : null,
          target_status: step.action_type === "change_status" ? step.target_status : null,
        })),
      }), { successMessage: "Drip saved", fallbackMessage: "Could not save drip" });
      if (result.ok) {
        setSteps((old) => old.map((step) => {
          const index = savedKeys.indexOf(step.key);
          return index < 0 ? step : { ...step, id: result.data[index] };
        }));
        router.replace(`/sequences/${sequence.id}/edit`);
        router.refresh();
      }
    });
  };

  return <div className="flex flex-col gap-6">
    <div className="flex justify-end"><Button variant="ghost" onClick={() => router.push("/sequences")}>Back to list</Button></div>
    <section className="flex max-w-2xl flex-col gap-4 rounded-md border p-4">
      <h2 className="font-semibold">Drip details</h2>
      <label htmlFor="seq-name" className="flex flex-col gap-1 text-sm"><span>Name</span>
        <Input id="seq-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <label htmlFor="seq-description" className="flex flex-col gap-1 text-sm"><span>Description</span>
        <Input id="seq-description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
    </section>
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between"><h2 className="font-semibold">Steps <span className="text-muted-foreground text-sm font-normal">· {steps.length} {steps.length === 1 ? "step" : "steps"}</span></h2>
        <Button variant="outline" onClick={() => setSteps((old) => [...old, blankStep(old.length)])}>Add step</Button>
      </div>
      {initialImpact.total_enrolled > 0 ? <p className="text-muted-foreground text-xs">Saved steps cannot be moved or deleted while leads are enrolled. You can edit text, add a step, or remove an unsaved step.</p> : null}
      {steps.length === 0 ? <div className="text-muted-foreground rounded-md border border-dashed p-6 text-sm">No steps yet. Add a step to start this drip.</div> :
        steps.map((step, index) => <StepEditor key={step.key} step={step} index={index}
          count={steps.length} locked={initialImpact.total_enrolled > 0} canDelete={!step.id} templates={templates} onChange={(patch) => patchStep(step.key, patch)}
          onMove={(delta) => moveStep(index, delta)} onDelete={() => removeStep(step.key)} />)}
    </section>
    <div><Button onClick={onSave} disabled={pending || !valid}>Save all steps</Button></div>
  </div>;
}

/**
 * Pick exactly one SMS source: custom body, saved template, or template pool.
 */
function MessageBodyEditor({
  templates,
  body,
  setBody,
  templateId,
  setTemplateId,
  templateCategory,
  setTemplateCategory,
}: {
  templates: TemplateRow[];
  body: string;
  setBody: (next: string) => void;
  templateId: string | null;
  setTemplateId: (next: string | null) => void;
  templateCategory: string | null;
  setTemplateCategory: (next: string | null) => void;
}) {
  const mode: "custom" | "template" | "category" = templateCategory ? "category" : templateId ? "template" : "custom";
  const setMode = (next: "custom" | "template") => {
    setTemplateCategory(null);
    if (next === "custom") {
      setTemplateId(null);
    } else {
      setTemplateId(templates[0]?.id ?? null);
    }
  };
  const selected = templates.find((t) => t.id === templateId);
  // WR-11: detect when the step references a template that's no longer
  // in the live list (soft-deleted in another tab / by a teammate).
  // Without this banner the <select> just shows nothing and the
  // upsert silently saves the dead id; tick.ts then pauses with
  // `template_missing` on the next fire — confusing for the author.
  const referencedTemplateMissing =
    mode === "template" && templateId !== null && selected === undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-sm">
        {templateCategory ? <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === "category"} readOnly />
          <span>Template pool: {templateCategory}</span>
        </label> : null}
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={mode === "custom"}
            onChange={() => setMode("custom")}
          />
          <span>Custom message</span>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={mode === "template"}
            onChange={() => setMode("template")}
            disabled={templates.length === 0}
          />
          <span>Use template{templates.length === 0 ? " (none yet)" : ""}</span>
        </label>
      </div>
      {referencedTemplateMissing ? (
        <div className="border-destructive/50 bg-destructive/5 text-destructive flex flex-col gap-1 rounded-md border px-3 py-2 text-xs">
          <span className="font-semibold">
            Referenced template no longer exists
          </span>
          <span>
            Pick a different template from the list, or switch to &ldquo;Custom
            message&rdquo;. Saving as-is will pause any enrollments hitting this
            step.
          </span>
        </div>
      ) : null}
      {mode === "category" ? <p className="text-muted-foreground text-xs">A template from this pool is chosen when the step sends.</p> : mode === "custom" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Message body</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            className="border-input rounded-md border px-2 py-1.5 font-mono text-sm"
            placeholder="Hi {{first_name}}, cash offer on {{property_address}}?"
          />
          <span className="text-muted-foreground text-xs">
            Type {"{{first_name}}"} or {"{{property_address}}"} and Sandra fills
            them in for each lead. Also available: last name, city, state, zip,
            market, your first name, company name.
          </span>
        </label>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Template</span>
            <select
              value={templateId ?? ""}
              onChange={(e) => setTemplateId(e.target.value || null)}
              className="border-input rounded-md border px-2 py-1.5 text-sm"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.category} — {t.name}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">
                Preview (variables resolve at send time)
              </span>
              <pre className="bg-muted/40 max-h-48 overflow-y-auto rounded-md p-3 text-xs whitespace-pre-wrap font-mono">
                {selected.content}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function StepEditor({ step, index, count, locked, canDelete, templates, onChange, onMove, onDelete }: {
  step: DraftStep;
  index: number;
  count: number;
  locked: boolean;
  canDelete: boolean;
  templates: TemplateRow[];
  onChange: (patch: Partial<DraftStep>) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
}) {
  return <div className="flex flex-col gap-3 rounded-md border p-4">
    <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Step {index + 1}</h3>
      <div className="flex items-center gap-1"><Button variant="ghost" size="sm" disabled={locked || index === 0} onClick={() => onMove(-1)}>Move up</Button>
        <Button variant="ghost" size="sm" disabled={locked || index === count - 1} onClick={() => onMove(1)}>Move down</Button>
        <Button variant="ghost" size="sm" disabled={locked && !canDelete} onClick={onDelete}>Delete</Button></div></div>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex flex-1 flex-col gap-1 text-sm"><span className="font-medium">Delay</span>
        <DelayInput value={step.delay_after_previous_minutes} onChange={(value) => onChange({ delay_after_previous_minutes: value })} />
      </div>
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Action</span>
        <select value={step.action_type} onChange={(e) => onChange({
          action_type: e.target.value as DraftStep["action_type"],
          template_body: null, template_id: null, template_category: null, target_status: null,
        })}
          className="border-input rounded-md border px-2 py-1.5 text-sm">
          <option value="send_sms">{systemLabel(SEQUENCE_ACTION_LABELS, "send_sms")}</option>
          <option value="change_status">{systemLabel(SEQUENCE_ACTION_LABELS, "change_status")}</option>
        </select>
      </label>
    </div>
    {step.action_type === "send_sms" ? <MessageBodyEditor templates={templates}
      body={step.template_body ?? ""} setBody={(value) => onChange({ template_body: value, template_category: null })}
      templateId={step.template_id ?? null} setTemplateId={(value) => onChange({ template_id: value, template_category: null })}
      templateCategory={step.template_category} setTemplateCategory={(value) => onChange({ template_category: value })} /> :
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Target status</span>
        <select value={step.target_status ?? ""} onChange={(e) => onChange({ target_status: e.target.value })}
          className="border-input rounded-md border px-2 py-1.5 text-sm">
          <option value="">— select —</option>
          {["new_lead", "contacted", "interested", "offer_sent", "offer_declined", "under_contract", "closed", "dead"].map((status) =>
            <option key={status} value={status}>{systemLabel(PROPERTY_STATUS_LABELS, status)}</option>)}
        </select>
      </label>}
  </div>;
}
