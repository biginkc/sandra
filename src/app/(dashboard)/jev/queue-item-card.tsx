"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import {
  confirmJevQueueItem,
  correctJevQueueItem,
  fetchCorrectionHistory,
  markJevQueueItemReviewed,
  promoteClassifierEventToDecision,
  type JevQueueSource,
} from "./actions";
import type { CorrectionHistoryEntry, JevQueueItem } from "./queries";

const OUTCOME_LABELS: Record<string, string> = {
  new_lead: "New lead",
  wrong_number: "Wrong number",
  not_interested: "Not interested",
  nurture: "Nurture",
  opted_out: "Opted out",
  dnc: "DNC",
  classification_failed: "Classification failed",
  unclear: "Unclear",
};

function label(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * A row's decision was already applied automatically (auto_accepted, or
 * a jev_lead_decision confirmed with no human involved) — it needs
 * "mark reviewed" (record a human looked at it, no re-apply), not
 * "confirm" (which performs the disposition write and only makes sense
 * for a still-pending row).
 */
function isAutoAppliedUnactedOn(item: JevQueueItem): boolean {
  return item.status !== "pending" && item.applicationState === "applied" && item.resolvedBy === null;
}

/**
 * One queue row: proposed outcome + confidence/threshold + model/rubric
 * version + evidence with a conversation link, a Confirm/Mark-reviewed
 * button as appropriate, and a direct outcome picker across the full
 * taxonomy for correcting to something else — no reviewer-name/evidence
 * form, the signed-in user is inferred by the RPC. Reused by both
 * Needs-a-decision (actionable) and Review Jev (read-mostly, but
 * confirm/mark-reviewed/correct all work from either surface).
 */
export function QueueItemCard({
  item,
  onResolved,
}: {
  item: JevQueueItem;
  onResolved?: (result: { status: string }) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<CorrectionHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // auto_accepted / system-confirmed rows are reviewable and correctable
  // (root direct-review finding, 2026-09-20) — canAct must not exclude
  // them. superseded rows and classifier_event rows have nothing left to
  // act on: superseded because a newer decision or human action already
  // replaced this one, classifier_event because no decision was ever made.
  const canAct = item.actionable && item.status !== "superseded";
  const isClassifierEvent = item.source === "classifier_event";
  const needsMarkReviewed = canAct && !isClassifierEvent && isAutoAppliedUnactedOn(item);
  // Fable review of 9cd4ec2b (jev-root-round15-fable-fixes.md), finding
  // 3: a PROMOTED classifier event (proposed_outcome 'unclear'/
  // 'bad_number' — a placeholder, never a real Jev decision) is not
  // confirmable: fn_confirm_jev_lead_decision only accepts 'new_lead'/
  // 'nurture' and would otherwise trip a raw DB constraint error. The
  // human must choose an actual supported outcome via the correction
  // picker below (always available — correctionTargets is the full
  // taxonomy for every jev_lead_decision row).
  const needsConfirm =
    canAct &&
    item.status === "pending" &&
    !isClassifierEvent &&
    item.proposedOutcome !== "unclear" &&
    item.proposedOutcome !== "bad_number";
  // Root final-review P1 #3: a classifier_event has no review/decision row
  // to confirm/correct — it must first be "promoted" into a real,
  // pending jev_lead_decisions row before any outcome can be chosen.
  const needsPromote = canAct && isClassifierEvent;

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await callAction(confirmJevQueueItem(item.source as JevQueueSource, item.id), {
        successMessage: `Confirmed ${label(item.proposedOutcome)}`,
        fallbackMessage: "Could not confirm",
      });
      if (result.ok) onResolved?.(result.data);
      else setError(result.error.message);
    });
  };

  const markReviewed = () => {
    setError(null);
    startTransition(async () => {
      const result = await callAction(markJevQueueItemReviewed(item.source as JevQueueSource, item.id), {
        successMessage: "Marked reviewed",
        fallbackMessage: "Could not mark reviewed",
      });
      if (result.ok) onResolved?.(result.data);
      else setError(result.error.message);
    });
  };

  const toggleHistory = () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    if (history !== null || item.source === "classifier_event") return;
    setHistoryLoading(true);
    startTransition(async () => {
      const result = await fetchCorrectionHistory(
        item.propertyId,
        item.source as "ai_disposition_review" | "jev_lead_decision",
        item.id,
      );
      setHistoryLoading(false);
      if (result.ok) setHistory(result.data.entries);
      else setError(result.error.message);
    });
  };

  const promote = () => {
    setError(null);
    startTransition(async () => {
      const result = await callAction(promoteClassifierEventToDecision(item.id), {
        successMessage: "Ready to resolve — choose the actual outcome below",
        fallbackMessage: "Could not start resolution",
      });
      if (result.ok) onResolved?.(result.data);
      else setError(result.error.message);
    });
  };

  const correct = (target: string) => {
    setError(null);
    startTransition(async () => {
      const result = await callAction(
        correctJevQueueItem(item.source as JevQueueSource, item.id, target, null),
        {
          successMessage: `Corrected to ${label(target)}`,
          fallbackMessage: "Could not correct",
        },
      );
      if (result.ok) {
        setPickerOpen(false);
        onResolved?.(result.data);
      } else {
        setError(result.error.message);
      }
    });
  };

  return (
    <div className="flex flex-col gap-2 border-b p-4" data-testid={`jev-queue-item-${item.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{item.propertyAddress ?? "Unknown address"}</p>
            {item.conversationId && (
              <Link
                href={`/messages?thread=${item.conversationId}`}
                className="text-xs text-primary underline"
                data-testid={`jev-conversation-link-${item.id}`}
              >
                View conversation
              </Link>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Jev proposed: <span className="font-medium">{label(item.proposedOutcome)}</span>
            {item.nativeConfidence !== null && <> · confidence {formatPercent(item.nativeConfidence)}</>}
            {item.thresholdAtDecision !== null && (
              <>
                {" "}
                (threshold {formatPercent(item.thresholdAtDecision)}
                {item.thresholdVersion !== null && <> v{item.thresholdVersion}</>})
              </>
            )}
          </p>
          {(item.model || item.schemaVersion || item.policyVersion) && (
            <p className="text-[11px] text-muted-foreground">
              {item.model && <>model {item.model}</>}
              {item.schemaVersion && <> · schema v{item.schemaVersion}</>}
              {item.policyVersion && <> · rubric {item.policyVersion}</>}
            </p>
          )}
          {item.evidenceBody ? (
            <blockquote className="mt-1 border-l-2 pl-2 text-xs italic text-muted-foreground">
              &ldquo;{item.evidenceBody}&rdquo;
            </blockquote>
          ) : (
            <p className="mt-1 text-xs italic text-muted-foreground" data-testid={`jev-missing-evidence-${item.id}`}>
              No message evidence available
              {item.correctionReason ? `: ${item.correctionReason}` : isClassifierEvent ? ": Jev's answer was unclear" : "."}
              {" — a human outcome is still required."}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Status: {item.status}
            {item.resolvedOutcome && ` → ${label(item.resolvedOutcome)}`}
            {item.humanReviewedAt && item.resolvedBy === null && " (marked reviewed by a human)"}
          </p>
          {item.correctedOutcome && (
            <p className="text-xs text-muted-foreground">
              Currently: corrected from {label(item.proposedOutcome)} to {label(item.correctedOutcome)}
              {item.correctionReason && `: "${item.correctionReason}"`}
              {item.resolvedAt && ` (${new Date(item.resolvedAt).toLocaleString()})`}
            </p>
          )}
          {item.correctionReason && !item.correctedOutcome && (
            <p className="text-xs text-muted-foreground">Note: {item.correctionReason}</p>
          )}
          {item.source !== "classifier_event" && (
            <>
              <button
                type="button"
                className="mt-1 text-xs text-primary underline"
                onClick={toggleHistory}
                data-testid={`jev-correction-history-toggle-${item.id}`}
              >
                {historyOpen ? "Hide" : "Show"} correction history
              </button>
              {historyOpen && (
                <div className="mt-1" data-testid={`jev-correction-history-${item.id}`}>
                  {historyLoading ? (
                    <p className="text-xs text-muted-foreground">Loading…</p>
                  ) : history && history.length > 0 ? (
                    <ol className="list-inside list-decimal space-y-0.5 text-xs text-muted-foreground">
                      {history.map((entry) => (
                        <li key={entry.id}>
                          {entry.correctedOutcome ? label(entry.correctedOutcome) : "unknown"}
                          {entry.reason && ` — "${entry.reason}"`} ({new Date(entry.createdAt).toLocaleString()})
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-xs text-muted-foreground">No corrections recorded.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {canAct && (
          <div className="flex shrink-0 flex-col items-end gap-2">
            <div className="flex gap-2">
              {needsConfirm && (
                <Button type="button" size="sm" disabled={pending} onClick={confirm} data-testid={`jev-confirm-${item.id}`}>
                  Confirm
                </Button>
              )}
              {needsMarkReviewed && (
                <Button
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={markReviewed}
                  data-testid={`jev-mark-reviewed-${item.id}`}
                >
                  Mark reviewed
                </Button>
              )}
              {needsPromote && (
                <Button type="button" size="sm" disabled={pending} onClick={promote} data-testid={`jev-promote-${item.id}`}>
                  Resolve
                </Button>
              )}
              {item.correctionTargets.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setPickerOpen((v) => !v)}
                  data-testid={`jev-correct-toggle-${item.id}`}
                >
                  Choose outcome
                </Button>
              )}
            </div>
            {pickerOpen && (
              <div className="flex flex-wrap justify-end gap-1">
                {item.correctionTargets.map((target) => (
                  <Button
                    key={target}
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => correct(target)}
                    data-testid={`jev-correct-${item.id}-${target}`}
                  >
                    {label(target)}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export type { JevQueueSource };
