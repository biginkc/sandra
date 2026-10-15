"use client";

import { type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Ellipsis, Phone, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useCoachCall } from "../_components/coach-call-context";
import { MY_LEAD_STAGE_LABELS, type MyLeadAction, type MyLeadStage } from "../_components/types";
import {
  brokenButton,
  dismissableBroken,
  rowButtons,
  type ButtonCommand,
  type ButtonSpec,
} from "./button-map";
import type { BrokenItem, WorkFacts } from "./contract";
import { brokenLines, expandedLines, labelChips, rowHeadline, type HeadlineTone } from "./copy";
import { SlotIconView, slotIconFor } from "./slot-icon";

/**
 * One row of the unified work queue (design v8 section 4). Pure presentation: no data fetching and no server
 * actions. Everything the rep can do arrives as a callback; the container wires them to the existing
 * workflows in client.tsx.
 */
export type WorkRowProps = {
  facts: WorkFacts;
  /** The clock the row text is computed against (the container's tick, so rows age together). */
  now: Date;
  expanded: boolean;
  /**
   * False when an owner views a rep's queue: every button is disabled except Open lead
   * (today's read-only strip semantics).
   */
  canAct: boolean;
  /** An action on this row is in flight; its buttons are disabled. */
  busy?: boolean;
  /** Tags the lead the rep arrived at from its lead page or Messages. */
  openedFromLead?: boolean;
  /** Show Undo for Call today (the container sets it after pinning; an active pin always shows it). */
  pinnedUndo?: boolean;
  /** The conversation box (and the all-texts thread) for the expanded row. */
  conversation?: ReactNode;
  /** Click on the row (not on its buttons) and the chevron. */
  onToggle: () => void;
  /** A stage command: the container opens the existing dialog or starts the existing workflow. */
  onAction: (kind: MyLeadAction, propertyId: string) => void;
  /** Reply / Text: open the all-texts thread with the composer. */
  onOpenText: (propertyId: string) => void;
  onCallToday: (propertyId: string) => void;
  onUndoCallToday: (propertyId: string) => void;
  /** Opens the existing drip picker. */
  onSetDrip: (propertyId: string) => void;
  /** Fix drip / Send text / Resend / Review / Check status / Open campaign for one broken item. */
  onBrokenAction: (item: BrokenItem, propertyId: string) => void;
  /** Dismiss a broken item that carries a refId. */
  onDismissBroken: (propertyId: string, refId: string) => void;
};

export const TONE_CLASSES: Record<HeadlineTone, string> = {
  info: "text-blue-700 dark:text-blue-300",
  danger: "text-red-700 dark:text-red-400",
  warn: "text-amber-700 dark:text-amber-400",
  offer: "text-violet-700 dark:text-violet-300",
  calm: "text-cyan-800 dark:text-cyan-300",
  success: "text-green-700 dark:text-green-400",
  muted: "text-muted-foreground",
};

const CHIP_TONE_CLASSES: Record<HeadlineTone, string> = {
  info: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200",
  danger: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  offer: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200",
  calm: "border-cyan-200 bg-cyan-50 text-cyan-900 dark:border-cyan-900 dark:bg-cyan-950 dark:text-cyan-200",
  success: "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200",
  muted: "border-stone-200 bg-stone-50 text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
};

// Same stage colours as the sectioned queue (queue-row.tsx STAGE_CARD_BORDER / queue.tsx STAGE_BAR).
const STAGE_CARD_BORDER: Record<MyLeadStage, string> = {
  not_contacted: "border-blue-200 border-l-blue-500 dark:border-blue-900 dark:border-l-blue-500",
  contacted: "border-teal-200 border-l-teal-600 dark:border-teal-900 dark:border-l-teal-500",
  needs_offer: "border-amber-200 border-l-amber-500 dark:border-amber-900 dark:border-l-amber-500",
  offer_sent: "border-violet-200 border-l-violet-500 dark:border-violet-900 dark:border-l-violet-500",
  under_contract: "border-green-200 border-l-green-600 dark:border-green-900 dark:border-l-green-500",
};

const STAGE_PILL: Record<MyLeadStage, string> = {
  not_contacted: "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300",
  contacted: "border-teal-200 bg-teal-100 text-teal-800 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-300",
  needs_offer: "border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  offer_sent: "border-violet-200 bg-violet-100 text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300",
  under_contract: "border-green-200 bg-green-100 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300",
};

/** "123 Main St, Kansas City, MO 64111": street, city, then state and zip (zip comes from the classifier facts). */
export function fullAddress(row: WorkFacts["row"], zip: string | null = null): string {
  const stateZip = [row.state, zip].filter((part) => part && part.trim()).join(" ");
  return [row.address, row.city, stateZip].filter((part) => part && part.trim()).join(", ");
}

export function WorkRow({
  facts,
  now,
  expanded,
  canAct,
  busy = false,
  openedFromLead = false,
  pinnedUndo = false,
  conversation,
  onToggle,
  onAction,
  onOpenText,
  onCallToday,
  onUndoCallToday,
  onSetDrip,
  onBrokenAction,
  onDismissBroken,
}: WorkRowProps) {
  const id = facts.propertyId;
  const coach = useCoachCall();
  const headline = rowHeadline(facts, now);
  const chips = labelChips(facts);
  const buttons = rowButtons(facts, { canAct, coachAvailable: Boolean(coach) });
  const name = facts.row.homeownerName || "Homeowner unavailable";
  const address = fullAddress(facts.row, facts.zip);
  const showUndo = pinnedUndo || facts.reason === "call_today";
  const readOnly = !canAct;
  const lockedBy = (button: ButtonSpec) => button.disabled || busy;

  function run(command: ButtonCommand) {
    switch (command.type) {
      case "action": onAction(command.action, id); break;
      case "text": onOpenText(id); break;
      case "call-today": onCallToday(id); break;
      case "set-drip": onSetDrip(id); break;
      case "broken": onBrokenAction(command.item, id); break;
      case "coach": coach?.call(id); break;
      case "link":
        window.open(command.href, "_blank", "popup,width=1200,height=900,noopener,noreferrer");
        break;
    }
  }

  // A click on the row itself toggles it; clicks on buttons, links and portaled menus do not.
  function onRowClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target)) return;
    if (target.closest("button, a, [role='menuitem'], input, select, textarea")) return;
    onToggle();
  }

  const openLead = (
    <a
      href={`/leads/${id}`}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={`work-row-open-lead-${id}`}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      Open lead
    </a>
  );

  const reasonNote = (button: ButtonSpec | null) =>
    button && button.disabledReason && !readOnly ? (
      <span className="text-[11px] font-semibold text-destructive" data-testid={`work-row-disabled-reason-${button.id}-${id}`}>
        {button.disabledReason}
      </span>
    ) : null;

  const primary = buttons.primary;
  const primaryIsCall = primary?.id === "call";
  const logAttempt = buttons.logAttempt;

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[14px] border border-l-[3px] bg-card text-card-foreground",
        STAGE_CARD_BORDER[facts.stage],
      )}
      data-testid={`work-row-${id}`}
      data-lead-id={id}
      data-reason={facts.reason}
      data-expanded={expanded}
    >
      <div
        className="flex w-full min-w-0 cursor-pointer flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-3.5 hover:bg-muted/30"
        onClick={onRowClick}
      >
        <SlotIconView icon={slotIconFor(facts)} />
        <div className="min-w-0 flex-1 basis-60 space-y-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="break-words text-[14.5px] font-bold">{name}</span>
            <Badge
              variant="secondary"
              data-testid={`work-row-stage-${id}`}
              className={cn("rounded-md border px-[7px] py-[2px] text-[9.5px] font-extrabold tracking-wide uppercase", STAGE_PILL[facts.stage])}
            >
              {MY_LEAD_STAGE_LABELS[facts.stage]}
            </Badge>
            {openedFromLead && (
              <Badge variant="secondary" className="border-teal-300 bg-teal-50 text-teal-900">
                Opened from lead page
              </Badge>
            )}
          </div>
          <p className="break-words text-[12.5px] text-muted-foreground" data-testid={`work-row-address-${id}`}>{address}</p>
          <p
            data-testid={`work-row-headline-${id}`}
            data-tone={headline.tone}
            className={cn("break-words text-[13px] font-bold", TONE_CLASSES[headline.tone])}
          >
            {headline.text}
          </p>
          {chips.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Lead labels">
              {chips.map((chip) => (
                <li
                  key={chip.key}
                  data-testid={`work-row-label-${chip.key}-${id}`}
                  className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", CHIP_TONE_CLASSES[chip.tone])}
                >
                  {chip.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        {!expanded && (
          <div className="flex shrink-0 flex-wrap items-center gap-2" role="group" aria-label={`Actions for ${name}`}>
            {primary && (
              <span className="inline-flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={lockedBy(primary)}
                  title={primary.disabledReason ?? undefined}
                  data-testid={`work-row-primary-${id}`}
                  onClick={() => run(primary.command)}
                >
                  {primaryIsCall && <Phone aria-hidden="true" />}
                  {primary.label}
                </Button>
                {reasonNote(primary)}
              </span>
            )}
            {showUndo && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={readOnly || busy}
                data-testid={`work-row-undo-${id}`}
                onClick={() => onUndoCallToday(id)}
              >
                <Undo2 aria-hidden="true" />
                Undo
              </Button>
            )}
            {openLead}
          </div>
        )}

        <button
          type="button"
          className="shrink-0 rounded-md p-1 text-[#a8a29e] outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label={expanded ? `Hide details for ${address || name}` : `Show details for ${address || name}`}
          aria-expanded={expanded}
          aria-controls={`work-row-detail-${id}`}
          data-testid={`work-row-toggle-${id}`}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
        </button>
      </div>

      <div id={`work-row-detail-${id}`} hidden={!expanded}>
        {expanded && (
          <div className="space-y-4 border-t border-[#f0eeec] px-4 pb-4 pt-3 pl-[52px] dark:border-border">
            <dl className="grid gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-[7rem_1fr]" data-testid={`work-row-lines-${id}`}>
              {expandedLines(facts, now).map((line) => (
                <div key={line.label} className="contents">
                  <dt className="text-[10px] font-extrabold tracking-[0.08em] text-muted-foreground uppercase sm:pt-0.5">{line.label}</dt>
                  <dd className={cn("min-w-0 break-words", line.tone && TONE_CLASSES[line.tone])}>{line.text}</dd>
                </div>
              ))}
            </dl>

            {facts.broken.length > 0 && (
              <BrokenList
                facts={facts}
                now={now}
                locked={readOnly || busy}
                onFix={(item) => onBrokenAction(item, id)}
                onDismiss={(refId) => onDismissBroken(id, refId)}
              />
            )}

            {conversation && <div data-testid={`work-row-conversation-${id}`}>{conversation}</div>}

            <div
              role="group"
              aria-label="Lead actions"
              data-testid={`work-row-actions-${id}`}
              className="grid grid-cols-2 gap-2 sm:max-w-md"
            >
              {primary && !primaryIsCall && (
                <div className="col-span-2 space-y-1">
                  <Button
                    type="button"
                    className="w-full"
                    disabled={lockedBy(primary)}
                    title={primary.disabledReason ?? undefined}
                    data-testid={`work-row-primary-${id}`}
                    onClick={() => run(primary.command)}
                  >
                    {primary.label}
                  </Button>
                  {reasonNote(primary)}
                </div>
              )}
              <div className="space-y-1">
                <Button
                  type="button"
                  variant={primaryIsCall || !primary ? "default" : "outline"}
                  className="w-full"
                  disabled={lockedBy(buttons.call)}
                  title={buttons.call.disabledReason ?? undefined}
                  data-testid={`work-row-call-${id}`}
                  onClick={() => run(buttons.call.command)}
                >
                  <Phone aria-hidden="true" />
                  Call
                </Button>
                {reasonNote(buttons.call)}
              </div>
              {logAttempt && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={lockedBy(logAttempt)}
                  data-testid={`work-row-log-attempt-${id}`}
                  onClick={() => run(logAttempt.command)}
                >
                  {logAttempt.label}
                </Button>
              )}
              {showUndo ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={readOnly || busy}
                  data-testid={`work-row-undo-${id}`}
                  onClick={() => onUndoCallToday(id)}
                >
                  <Undo2 aria-hidden="true" />
                  Undo Call today
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={lockedBy(buttons.callToday)}
                  data-testid={`work-row-call-today-${id}`}
                  onClick={() => run(buttons.callToday.command)}
                >
                  {buttons.callToday.label}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={lockedBy(buttons.setDrip)}
                data-testid={`work-row-set-drip-${id}`}
                onClick={() => run(buttons.setDrip.command)}
              >
                {buttons.setDrip.label}
              </Button>
              {openLead}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={readOnly || busy}
                      aria-label={`More actions for ${name}`}
                      data-testid={`work-row-more-${id}`}
                    >
                      More
                      <Ellipsis aria-hidden="true" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-auto">
                  {buttons.more.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      disabled={item.disabled}
                      variant={item.danger ? "destructive" : "default"}
                      data-testid={`work-row-menu-${item.id}-${id}`}
                      onClick={() => run(item.command)}
                    >
                      {item.label}
                      {item.disabledReason && !readOnly ? <span className="text-xs text-muted-foreground"> · {item.disabledReason}</span> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function BrokenList({
  facts,
  now,
  locked,
  onFix,
  onDismiss,
}: {
  facts: WorkFacts;
  now: Date;
  locked: boolean;
  onFix: (item: BrokenItem) => void;
  onDismiss: (refId: string) => void;
}) {
  const id = facts.propertyId;
  const dismissable = new Set(dismissableBroken(facts));
  return (
    <section aria-label="What broke" className="space-y-2" data-testid={`work-row-broken-${id}`}>
      <h3 className="text-[10px] font-extrabold tracking-[0.08em] text-red-700 uppercase dark:text-red-400">Broken</h3>
      <ul className="space-y-2">
        {brokenLines(facts, now).map(({ item, text }, index) => {
          const fix = brokenButton(item, facts);
          return (
            <li key={`${item.kind}-${item.refId ?? index}`} className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <span className="min-w-0 flex-1 basis-48 break-words">{text}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={locked || fix.disabled}
                title={fix.disabledReason ?? undefined}
                data-testid={`work-row-broken-fix-${index}-${id}`}
                onClick={() => onFix(item)}
              >
                {fix.label}
              </Button>
              {dismissable.has(item) && item.refId && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={locked}
                  data-testid={`work-row-broken-dismiss-${index}-${id}`}
                  onClick={() => onDismiss(item.refId as string)}
                >
                  Dismiss
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
