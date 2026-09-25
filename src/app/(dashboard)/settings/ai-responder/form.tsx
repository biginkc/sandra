"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";

import {
  updateAiResponderConfig,
  updateJevAutomaticClassification,
  type AiResponderConfigRow,
} from "./actions";

export function AiResponderConfigForm({
  initial,
}: {
  initial: AiResponderConfigRow;
}) {
  const [active, setActive] = useState(initial.active);
  const [systemPrompt, setSystemPrompt] = useState(initial.system_prompt);
  const [maxTurns, setMaxTurns] = useState(initial.max_turns);
  const [minConfidence, setMinConfidence] = useState(initial.min_confidence);
  const [replyDelayMin, setReplyDelayMin] = useState(
    initial.reply_delay_min_seconds,
  );
  const [replyDelayMax, setReplyDelayMax] = useState(
    initial.reply_delay_max_seconds,
  );
  const [businessHours, setBusinessHours] = useState(
    initial.business_hours_only,
  );
  const [pending, startTransition] = useTransition();

  // Root review of 3e4ee3b1 (jev-root-round12-review.md), finding 3: the
  // one-cutover switch — deliberately its own state, own transition, and
  // own save action, so it can never be bundled into (or blocked by) an
  // unrelated edit to the fields above.
  const jevEnabledInitially =
    initial.classifier_provider === "jev" && initial.classifier_mode === "automatic";
  const [jevEnabled, setJevEnabled] = useState(jevEnabledInitially);
  const [jevSaved, setJevSaved] = useState(jevEnabledInitially);
  const [jevError, setJevError] = useState<string | null>(null);
  const [jevPending, startJevTransition] = useTransition();

  const onSaveJevSwitch = () => {
    setJevError(null);
    startJevTransition(async () => {
      const result = await callAction(
        updateJevAutomaticClassification({
          configId: initial.id,
          enabled: jevEnabled,
        }),
        {
          successMessage: jevEnabled
            ? "Automatic Jev classification enabled"
            : "Automatic Jev classification disabled",
          fallbackMessage: "Could not update Jev automatic classification",
        },
      );
      if (result.ok) {
        setJevSaved(jevEnabled);
      } else {
        setJevError(result.error.message);
      }
    });
  };

  const onSave = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      await callAction(
        updateAiResponderConfig({
          configId: initial.id,
          active,
          system_prompt: systemPrompt,
          max_turns: maxTurns,
          min_confidence: minConfidence,
          business_hours_only: businessHours,
          reply_delay_min_seconds: replyDelayMin,
          reply_delay_max_seconds: replyDelayMax,
        }),
        {
          successMessage: "AI responder config saved",
          fallbackMessage: "Could not save config",
        },
      );
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-md border p-4" data-testid="jev-automatic-switch">
        <h2 className="font-semibold">Use Jev automatic classification</h2>
        <p className="text-muted-foreground text-xs">
          One post-deployment cutover switch, not a gradual rollout. Enabled maps this
          org to Jev + automatic decisioning: Jev classifies every inbound and applies
          any above-threshold outcome itself (new_lead, wrong_number, not_interested,
          nurture, opted_out) — DNC and unclear stay human-gated either way. Disabled
          maps back to legacy + shadow (Claude classify+reply, Jev only shadow-logs).
          Currently:{" "}
          <span className="font-medium" data-testid="jev-automatic-current-state">
            {jevSaved ? "Jev automatic" : "legacy / shadow"}
          </span>
          .
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={jevEnabled}
            onChange={(e) => setJevEnabled(e.target.checked)}
            className="mt-0.5"
            data-testid="jev-automatic-toggle"
          />
          <span className="font-medium">Enabled</span>
        </label>
        {jevError && (
          <p className="text-destructive text-xs" data-testid="jev-automatic-error">
            {jevError}
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={jevPending || jevEnabled === jevSaved}
            onClick={onSaveJevSwitch}
            data-testid="jev-automatic-save"
          >
            {jevEnabled === jevSaved ? "Saved" : "Save switch"}
          </Button>
        </div>
      </section>

      <form onSubmit={onSave} className="flex flex-col gap-6">
      <section className="flex flex-col gap-4 rounded-md border p-4">
        <h2 className="font-semibold">Status</h2>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="mt-0.5"
            data-testid="ai-active-toggle"
          />
          <span className="flex-1">
            <span className="font-medium">Active</span>
            <span className="text-muted-foreground block text-xs">
              Turn the AI responder on or off org-wide. Property-level kill
              switches on each lead detail page override this when enabled.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={businessHours}
            onChange={(e) => setBusinessHours(e.target.checked)}
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="font-medium">
              Only reply during business hours
            </span>
            <span className="text-muted-foreground block text-xs">
              When on, AI replies only within the property&apos;s
              08:00–21:00 local window. When off, AI can draft replies
              24/7 (the outbound send pipeline still enforces quiet
              hours at send time).
            </span>
          </span>
        </label>
      </section>

      <section className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="font-semibold">System prompt</h2>
        <p className="text-muted-foreground text-xs">
          Sent on every Claude call. Cached (90% cheaper on repeat reads within
          5 minutes).
        </p>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={14}
          className="border-input rounded-md border px-2 py-1.5 font-mono text-xs"
        />
      </section>

      <section className="grid gap-4 rounded-md border p-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Max turns</span>
          <Input
            type="number"
            min={1}
            max={10}
            value={maxTurns}
            onChange={(e) =>
              setMaxTurns(Math.max(1, Math.min(10, Number(e.target.value))))
            }
          />
          <span className="text-muted-foreground text-xs">
            After this many AI replies, escalates.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Min confidence</span>
          <Input
            type="number"
            step="0.05"
            min={0}
            max={1}
            value={minConfidence}
            onChange={(e) =>
              setMinConfidence(Math.max(0, Math.min(1, Number(e.target.value))))
            }
          />
          <span className="text-muted-foreground text-xs">
            Model confidence below this → escalate.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Reply delay min (seconds)</span>
          <Input
            type="number"
            min={0}
            max={900}
            value={replyDelayMin}
            onChange={(e) =>
              setReplyDelayMin(Math.max(0, Math.min(900, Number(e.target.value))))
            }
          />
          <span className="text-muted-foreground text-xs">
            0 / 0 = reply instantly.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Reply delay max (seconds)</span>
          <Input
            type="number"
            min={0}
            max={900}
            value={replyDelayMax}
            onChange={(e) =>
              setReplyDelayMax(Math.max(0, Math.min(900, Number(e.target.value))))
            }
          />
          <span className="text-muted-foreground text-xs">
            0 / 0 = reply instantly.
          </span>
        </label>

      </section>

      <section className="flex flex-col gap-2 rounded-md border p-4 text-xs">
        <h2 className="font-semibold text-sm">Read-only info</h2>
        <div>
          <span className="text-muted-foreground">Model:</span>{" "}
          <code>{initial.model}</code>
        </div>
        <div>
          <span className="text-muted-foreground">Escalation keywords:</span>{" "}
          <code className="break-all">
            {initial.escalation_keywords.join(", ")}
          </code>
        </div>
        <div>
          <span className="text-muted-foreground">Last updated:</span>{" "}
          {new Date(initial.updated_at).toLocaleString()}
        </div>
      </section>

      <div>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </div>
      </form>
    </div>
  );
}
