"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";

import {
  updateAiResponderConfig,
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
  const [businessHours, setBusinessHours] = useState(
    initial.business_hours_only,
  );
  const [pending, startTransition] = useTransition();

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
        }),
        {
          successMessage: "AI responder config saved",
          fallbackMessage: "Could not save config",
        },
      );
    });
  };

  return (
    <form onSubmit={onSave} className="flex max-w-3xl flex-col gap-6">
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
  );
}
