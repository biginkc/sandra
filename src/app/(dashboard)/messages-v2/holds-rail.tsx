"use client";

import { format } from "date-fns/format";

import { cn } from "@/lib/utils";

import type { HoldActionsApi } from "./hold-action-types";
import {
  DisabledHoldActions,
  effectiveDraftBody,
  HoldActionControls,
} from "./hold-action-controls";
import { holdReason } from "./step-format";
import type {
  HoldsMeta,
  HoldSource,
  OpenHold,
  RunLabel,
  RunWithSteps,
} from "./types";

const HOUR = 60 * 60 * 1000;

export type AgeTone = "neutral" | "amber" | "red";

export function ageTone(ageMs: number): AgeTone {
  if (ageMs > 4 * HOUR) return "red";
  if (ageMs > HOUR) return "amber";
  return "neutral";
}

function formatAge(ageMs: number): string {
  const mins = Math.max(0, Math.floor(ageMs / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

const TONE_CLASS: Record<AgeTone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

/** Reason codes only for skips; a failure shows just "failed" (the stored error can be provider text). */
function alertText(alert: NonNullable<OpenHold["alert"]>): string {
  return alert.status === "skipped" && alert.reason
    ? `alert: skipped (${alert.reason})`
    : `alert: ${alert.status}`;
}

export function HoldCard({
  hold,
  label,
  nowMs,
  actions,
  onReload,
}: {
  hold: OpenHold<RunWithSteps>;
  label: RunLabel | undefined;
  nowMs: number;
  /** Re-fetch page data (a card the server found out of date). */
  onReload?: () => void;
  /** Server actions for the five hold actions; absent = shown disabled. */
  actions?: HoldActionsApi;
}) {
  const run = hold.run;
  const age = hold.since ? Math.max(0, nowMs - Date.parse(hold.since)) : null;
  const tone = age === null ? "neutral" : ageTone(age);
  const why = run ? holdReason(run.steps, run.reason) : null;
  // Already delivered (late) and nothing else needs a human: muted, not actionable.
  // Derive per-inbound dead-letter state; fall back to the booleans when no list.
  const dls = hold.dead_letters;
  const hasLate = dls ? dls.some((d) => d.late) : !!hold.dead_letter_late;
  const hasOpenDead = dls
    ? dls.some((d) => !d.late)
    : !!hold.dead_letter && !hold.dead_letter_late;
  const informational =
    hold.flag_reason === "send_timeout_then_sent" &&
    hold.sources.every((s) => s === "needs_attention") &&
    !hasOpenDead;
  return (
    <article
      data-testid="hold-card"
      {...(informational ? { "data-informational": "true" } : {})}
      className={cn(
        "rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10",
        informational && "opacity-70",
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {hold.since ? (
          <time
            suppressHydrationWarning
            dateTime={hold.since}
            className="text-xs tabular-nums text-muted-foreground"
          >
            {format(new Date(hold.since), "h:mm a")}
          </time>
        ) : (
          <span className="text-xs text-muted-foreground">time unknown</span>
        )}
        <span className="font-semibold">{label?.name ?? "Unknown sender"}</span>
        {label?.address && (
          <span className="text-muted-foreground">· {label.address}</span>
        )}
        <span
          data-testid="hold-age"
          data-tone={tone}
          className={cn(
            "ml-auto rounded-full px-2 text-xs tabular-nums",
            TONE_CLASS[tone],
          )}
        >
          {age === null ? "age unknown" : formatAge(age)}
        </span>
      </header>
      {run?.inbound_preview && (
        <p className="mt-2 flex gap-2">
          <span aria-hidden className="text-muted-foreground">
            ◀
          </span>
          <span>{run.inbound_preview}</span>
        </p>
      )}
      <p className="mt-2 flex gap-2">
        <span aria-hidden className="text-sky-600">
          ●
        </span>
        <span>
          {hold.reason}
          {why ? ` · ${why}` : ""}
        </span>
      </p>
      {hold.draft_held && (
        <p data-testid="draft-held" className="mt-2 flex gap-2">
          <span aria-hidden className="text-violet-600">
            ●
          </span>
          <span>Claude draft held</span>
        </p>
      )}
      {effectiveDraftBody(hold) !== null && (
        <p
          data-testid="draft-text"
          className="mt-1 whitespace-pre-wrap rounded-lg bg-secondary/60 p-2"
        >
          {effectiveDraftBody(hold)}
        </p>
      )}
      {hold.alert && (
        <p
          data-testid="hold-alert"
          data-status={hold.alert.status}
          className={cn(
            "mt-2 text-xs",
            hold.alert.status === "failed"
              ? "text-red-700 dark:text-red-300"
              : hold.alert.status === "skipped"
                ? "text-amber-700 dark:text-amber-300"
                : "text-muted-foreground",
          )}
        >
          {alertText(hold.alert)}
        </p>
      )}
      {informational && (
        <p
          data-testid="hold-informational"
          className="mt-2 text-xs text-muted-foreground"
        >
          Informational — accepted by provider late
        </p>
      )}
      {hasLate && (
        <p
          data-testid="dead-letter-late"
          className="mt-2 flex gap-2 text-muted-foreground"
        >
          <span aria-hidden>●</span>
          <span>reply accepted by provider late — do not re-send</span>
        </p>
      )}
      {hasOpenDead && (
        <p data-testid="dead-letter" className="mt-2 flex gap-2">
          <span aria-hidden className="text-amber-600">
            ●
          </span>
          <span>reply text saved for review</span>
        </p>
      )}
      {!informational &&
        (actions ? (
          <HoldActionControls
            // A changed draft or hold remounts the controls, so no stale edit text or status survives a reload.
            key={`${hold.draft?.id ?? ""}|${hold.draft?.edited_at ?? ""}|${hold.draft?.body ?? ""}|${hold.seen?.through ?? ""}|${hold.seen?.flagAt ?? ""}`}
            hold={hold}
            actions={actions}
            onReload={onReload}
          />
        ) : (
          <DisabledHoldActions title="Actions unavailable" />
        ))}
    </article>
  );
}

const SOURCE_NAME: Record<HoldSource, string> = {
  needs_attention: "needs-attention",
  jev_decision: "Jev decision",
  disposition_review: "disposition review",
  pending_draft: "reply draft",
};

export function HoldsRail({
  holds,
  labels,
  nowMs,
  meta,
  actions,
  onReload,
}: {
  meta?: HoldsMeta;
  actions?: HoldActionsApi;
  onReload?: () => void;
  holds: readonly OpenHold<RunWithSteps>[];
  labels: ReadonlyMap<string, RunLabel>;
  nowMs: number;
}) {
  const holdFailures = meta?.failed ?? [];
  const count =
    meta?.totalState === "unavailable"
      ? `(count unavailable, ${holds.length} shown)`
      : meta?.totalState === "capped"
        ? `(2,000+ holds (incomplete), ${meta.shown} shown)`
        : meta?.totalState === "incomplete"
          ? `(${meta.total}+ holds (incomplete), ${meta.shown} shown)`
          : meta?.truncated
            ? `(${meta.total}, ${meta.shown} shown)`
            : `(${holds.length})`;
  return (
    <aside
      aria-label="Holds"
      data-testid="holds-scroll"
      className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1"
    >
      <h2 className="lg:sticky lg:top-0 z-10 bg-background pb-1 text-sm font-semibold">
        Holds <span className="text-muted-foreground">{count}</span>
      </h2>
      {holdFailures.length > 0 && (
        <p
          role="alert"
          data-testid="holds-unavailable"
          className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          Holds unavailable —{" "}
          {holdFailures.map((f) => SOURCE_NAME[f]).join(", ")} query failed
        </p>
      )}
      {meta?.deadLetterUnavailable && (
        <p
          role="alert"
          data-testid="dead-letter-unavailable"
          className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          dead-letter status unavailable — saved-reply markers may be missing.
        </p>
      )}
      {meta && meta.contextErrors.length > 0 && (
        <p
          role="alert"
          data-testid="holds-context-errors"
          className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          Some hold details failed to load ({meta.contextErrors.join(", ")});
          cards may be missing run context.
        </p>
      )}
      {holds.length === 0 ? (
        holdFailures.length > 0 ? null : (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            No open holds.
          </p>
        )
      ) : (
        holds.map((hold) => (
          <HoldCard
            key={hold.id}
            hold={hold}
            label={labels.get(hold.id)}
            nowMs={nowMs}
            actions={actions}
            onReload={onReload}
          />
        ))
      )}
    </aside>
  );
}
