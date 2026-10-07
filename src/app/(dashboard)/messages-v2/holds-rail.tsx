"use client";

import { format } from "date-fns/format";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

const ACTIONS = ["Send", "Edit", "Take over ↗", "Assign", "Dismiss"] as const;

/** Phase 0 is read-only: every action renders disabled with a Phase 2 tooltip. */
function Phase2Actions() {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {ACTIONS.map((action) => (
        <span key={action} title="Phase 2">
          <Button type="button" size="xs" variant="outline" disabled>
            {action}
          </Button>
        </span>
      ))}
    </div>
  );
}

export function HoldCard({
  hold,
  label,
  nowMs,
}: {
  hold: OpenHold<RunWithSteps>;
  label: RunLabel | undefined;
  nowMs: number;
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
          <span>Claude draft held (Phase 1 to act)</span>
        </p>
      )}
      {informational && (
        <p
          data-testid="hold-informational"
          className="mt-2 text-xs text-muted-foreground"
        >
          Informational — already delivered
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
      {!informational && <Phase2Actions />}
    </article>
  );
}

export function ShadowScorecard() {
  return (
    <section
      aria-label="Shadow scorecard"
      className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
    >
      <h3 className="font-medium text-foreground">Shadow scorecard</h3>
      <p className="mt-1">Available after 2h of shadow traffic.</p>
    </section>
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
}: {
  meta?: HoldsMeta;
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
    <aside aria-label="Holds" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">
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
          />
        ))
      )}
      <ShadowScorecard />
    </aside>
  );
}
