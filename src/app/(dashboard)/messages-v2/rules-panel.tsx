"use client";

import { Settings } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { pageText } from "./page-text";
import { isEditableBadge, LabelRuleEditor } from "./label-rule-editor";
import { NurtureAutoDripSwitch, type NurtureAutoDripState } from "./nurture-auto-drip-switch";
import { formatModeBadge } from "./queries";
import { ReplyGenerationToggle, type SetReplyGenerationAction } from "./reply-generation-toggle";
import type { ReplyGeneration } from "./reply-generation";
import type { ModeBadge } from "./types";

/** "N% sure or more" for a 0..1 cutoff; keeps a decimal only when there is one (0.925 -> 92.5%). */
export function sureOrMore(cutoff: number): string {
  return `${Math.round(cutoff * 1000) / 10}% sure or more`;
}

type RuleRow = { outcome: string; title: string; detail: string };
type RuleGroup = { heading: string; rows: RuleRow[] };

/** Today's five switches, in plain English, grouped by who ends up acting. Same switches as the old header badges. */
const GROUPS: RuleGroup[] = [
  {
    heading: "Becomes a lead",
    rows: [
      {
        outcome: "new_lead",
        title: "Open to selling or wants an offer",
        detail: "Marks the seller as a lead for a person to follow up.",
      },
    ],
  },
  {
    heading: "Sandra handles alone",
    rows: [
      { outcome: "nurture", title: "Maybe later", detail: "Sends the approved reply. The drip switch below decides whether a drip starts." },
      { outcome: "not_interested", title: "Not interested", detail: "Sends the approved reply." },
      { outcome: "wrong_number", title: "Wrong person", detail: "Sends the approved reply." },
    ],
  },
  {
    heading: "Waits for a person",
    rows: [
      {
        outcome: "opted_out",
        title: "Asked to stop",
        detail: "Do-not-contact can't be undone, so a person confirms it. The word STOP still works on its own.",
      },
    ],
  },
];

function stateText(badge: ModeBadge | undefined): { text: string; tone: "on" | "off" | "watch" | "unknown" } {
  if (!badge) return { text: "Not set up", tone: "unknown" };
  switch (badge.mode) {
    case "AUTO":
      return {
        text: badge.minConfidence != null ? `On · ${sureOrMore(badge.minConfidence)}` : "On",
        tone: "on",
      };
    case "HELD":
      return { text: "Off · waits for a person", tone: "off" };
    case "SHADOW":
    case "LEGACY":
      return { text: "Watching only · acts on nothing yet", tone: "watch" };
    default:
      return { text: "Unknown", tone: "unknown" };
  }
}

const TONE: Record<"on" | "off" | "watch" | "unknown", string> = {
  on: "bg-status-new-bg text-status-new-fg border-status-new-border",
  off: "bg-status-contacted-bg text-status-contacted-fg border-status-contacted-border",
  watch: "bg-status-replying-bg text-status-replying-fg border-status-replying-border",
  unknown: "bg-status-replying-bg text-status-replying-fg border-status-replying-border",
};

function Row({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return (
    <div data-testid="rule-row" className="flex items-center gap-3 rounded-2xl border px-3.5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="font-semibold">{title}</b>
        <span className="text-[13px] text-muted-foreground">{detail}</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">{children}</div>
    </div>
  );
}

/** The `Sandra's rules` button and the side panel it opens. Replaces the header badge row. */
export function RulesPanel({
  orgId,
  isOwner,
  badges,
  badgesError,
  nurtureAutoDrip,
  replyGeneration,
  setReplyGeneration,
}: {
  orgId: string;
  isOwner: boolean;
  badges: ModeBadge[];
  badgesError?: string | null;
  nurtureAutoDrip?: NurtureAutoDripState | null;
  replyGeneration?: { configId: string; replyGeneration: ReplyGeneration } | null;
  setReplyGeneration?: SetReplyGenerationAction;
}) {
  const [open, setOpen] = useState(false);
  const byOutcome = new Map(badges.map((b) => [b.label, b]));

  return (
    <>
      <Button type="button" data-testid="open-rules" onClick={() => setOpen(true)}>
        <Settings aria-hidden className="size-3.5" />
        Sandra&apos;s rules
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          data-testid="rules-panel"
          className="w-full gap-0 overflow-y-auto sm:max-w-[560px]"
        >
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle className="text-xl font-semibold">Sandra&apos;s rules</SheetTitle>
            <SheetDescription>What Sandra may do on her own. Changes take effect on the next text.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 px-6 py-4">
            {badgesError && (
              <p role="alert" data-testid="badges-unavailable" className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-800">
                {pageText(badgesError)}
              </p>
            )}
            {GROUPS.map((group) => (
              <section key={group.heading} aria-label={group.heading} className="flex flex-col gap-2">
                <h3 className="pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.heading}</h3>
                {group.rows.map((row) => {
                  const badge = byOutcome.get(row.outcome);
                  const st = stateText(badge);
                  return (
                    <Row key={row.outcome} title={row.title} detail={row.detail}>
                      <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", TONE[st.tone])}>
                        {st.text}
                      </span>
                      {isOwner && badge && isEditableBadge(badge) && (
                        <LabelRuleEditor
                          orgId={orgId}
                          badge={badge}
                          text={`${badge.label} [${formatModeBadge(badge)}]`}
                          trigger="button"
                        />
                      )}
                    </Row>
                  );
                })}
              </section>
            ))}

            <section aria-label="Drips and drafts" className="flex flex-col gap-2">
              <h3 className="pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Drips and drafts</h3>
              {nurtureAutoDrip && isOwner && (
                <Row
                  title="Start the drip after a Maybe later reply"
                  detail="Only after the approved reply has gone out. A person can stop it from the lead page."
                >
                  <span
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                      nurtureAutoDrip.enabled ? TONE.on : TONE.off,
                    )}
                  >
                    {nurtureAutoDrip.enabled ? "On" : "Off"}
                  </span>
                  <NurtureAutoDripSwitch state={nurtureAutoDrip} trigger="button" />
                </Row>
              )}
              {replyGeneration && (
                <Row title="Sandra writes reply drafts" detail="Off means Sandra writes no reply drafts.">
                  <ReplyGenerationToggle
                    configId={replyGeneration.configId}
                    replyGeneration={replyGeneration.replyGeneration}
                    isOwner={isOwner}
                    action={setReplyGeneration}
                  />
                </Row>
              )}
            </section>


          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
