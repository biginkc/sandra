"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { callAction } from "@/lib/errors/call-action";

import { type TemplateRow } from "./actions";
import { setAutoReplyMapping } from "./auto-reply-actions";
import {
  AUTO_REPLY_OUTCOMES,
  type AutoReplyOutcome,
  type AutoReplySettings,
} from "./auto-reply-types";

type Props = {
  settings: AutoReplySettings;
  templates: Pick<TemplateRow, "id" | "name" | "approved_for_auto_send">[];
};

/**
 * Owner-only: which approved template answers which label. Choosing a template
 * only maps it; nothing is sent unless the template is approved AND the label's
 * automation switch is on (Messages v2 header) AND the confidence clears the
 * label's cutoff.
 */
export function AutoReplySettingsSection({ settings, templates }: Props) {
  const [pending, startTransition] = useTransition();
  const byId = new Map(templates.map((t) => [t.id, t]));
  const approved = templates.filter((t) => t.approved_for_auto_send === true);

  const save = (outcome: AutoReplyOutcome, templateId: string | null, active: boolean) => {
    startTransition(async () => {
      const result = await callAction(setAutoReplyMapping({ outcome, templateId, active }), {
        fallbackMessage: "Failed to save automatic reply",
      });
      if (result.ok) toast.success("Automatic reply saved");
    });
  };

  return (
    <Card data-testid="auto-reply-settings">
      <CardHeader>
        <CardTitle>Automatic replies</CardTitle>
        <CardDescription>
          Pick which approved template answers each label. Only templates marked
          &ldquo;Approved for automatic replies&rdquo; can be chosen, and nothing is
          sent while a label&rsquo;s automation is switched off.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {AUTO_REPLY_OUTCOMES.map(({ outcome, label }) => {
          const mapping = settings.mappings.find((m) => m.outcome === outcome);
          const mapped = mapping ? byId.get(mapping.templateId) : undefined;
          const options = [...approved];
          if (mapped && mapped.approved_for_auto_send !== true) options.push(mapped);
          const labelOn = settings.labelAutomation[outcome];
          return (
            <div key={outcome} className="flex flex-col gap-1" data-testid={`auto-reply-row-${outcome}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-32 text-sm font-medium">{label}</span>
                <select
                  aria-label={`Automatic reply template for ${label}`}
                  data-testid={`auto-reply-select-${outcome}`}
                  className="border-input bg-background h-8 min-w-56 rounded-md border px-2 text-sm"
                  value={mapping?.templateId ?? ""}
                  disabled={pending}
                  onChange={(e) => save(outcome, e.target.value || null, mapping?.active ?? true)}
                >
                  <option value="">No automatic reply</option>
                  {options.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.approved_for_auto_send === true ? "" : " (not approved)"}
                    </option>
                  ))}
                </select>
                {mapping && (
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`Active: ${label}`}
                      checked={mapping.active}
                      disabled={pending}
                      onChange={(e) => save(outcome, mapping.templateId, e.target.checked)}
                    />
                    Active
                  </label>
                )}
              </div>
              {mapping && mapped && mapped.approved_for_auto_send !== true && (
                <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
                  This template is not approved, so nothing will be sent.
                </p>
              )}
              {mapping && labelOn === false && (
                <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
                  Automation for this label is off, so nothing will be sent.
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
