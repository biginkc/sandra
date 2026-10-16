"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { Result } from "@/lib/errors/result";
import { cn } from "@/lib/utils";

import { pageText } from "./page-text";
import type { AiRuleSwitch, AiRuleSwitchState } from "./threshold-actions";

export type SetAiRuleSwitchAction = (input: {
  configId: string;
  switch: AiRuleSwitch;
  value: string;
}) => Promise<Result<AiRuleSwitchState>>;

/**
 * One owner switch on the rules panel (PR 4). Writes through `fn_set_ai_rule_switch`
 * only; shows what the database confirmed, never an optimistic value. Fails closed:
 * an error leaves the last confirmed state on screen.
 */
export function RuleSwitch({
  state,
  name,
  onValue,
  offValue,
  isOwner,
  action,
  onChange,
}: {
  state: AiRuleSwitchState;
  name: AiRuleSwitch;
  onValue: string;
  offValue: string;
  isOwner: boolean;
  action?: SetAiRuleSwitchAction;
  /** Gets an updater that changes ONLY this switch, so an older reply for another switch cannot undo a newer one. */
  onChange: (update: (prev: AiRuleSwitchState) => AiRuleSwitchState) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current =
    name === "nine_identity_reply"
      ? String(state.nineIdentityReply)
      : name === "nine_confirmed_owner_drip"
        ? String(state.nineConfirmedOwnerDrip)
        : state.classifierEngine;
  const on = current === onValue;

  const flip = async () => {
    if (!action) return;
    setPending(true);
    setError(null);
    try {
      const result = await action({ configId: state.configId, switch: name, value: on ? offValue : onValue });
      if (result.ok) {
        const confirmed = result.data;
        onChange((prev) =>
          name === "nine_identity_reply"
            ? { ...prev, nineIdentityReply: confirmed.nineIdentityReply }
            : name === "nine_confirmed_owner_drip"
              ? { ...prev, nineConfirmedOwnerDrip: confirmed.nineConfirmedOwnerDrip }
              : { ...prev, classifierEngine: confirmed.classifierEngine },
        );
      }
      else setError(pageText(result.error.message));
    } catch {
      setError("Could not change this. Nothing was changed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <span
        data-testid={`rule-switch-state-${name}`}
        className={cn(
          "rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
          on
            ? "bg-status-new-bg text-status-new-fg border-status-new-border"
            : "bg-status-contacted-bg text-status-contacted-fg border-status-contacted-border",
        )}
      >
        {on ? "On" : "Off"}
      </span>
      {isOwner && action && (
        <Button type="button" size="xs" variant="outline" data-testid={`rule-switch-${name}`} disabled={pending} onClick={flip}>
          {on ? "Turn off" : "Turn on"}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      )}
    </>
  );
}
