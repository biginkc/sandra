"use client";

import { format } from "date-fns/format";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { holdReason } from "./step-format";
import type { OpenHold, RunLabel, RunWithSteps } from "./types";

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
  const age = Math.max(0, nowMs - Date.parse(hold.since));
  const tone = ageTone(age);
  const why = run ? holdReason(run.steps, run.reason) : null;
  return (
    <article
      data-testid="hold-card"
      className="rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10"
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <time
          suppressHydrationWarning
          dateTime={hold.since}
          className="text-xs tabular-nums text-muted-foreground"
        >
          {format(new Date(hold.since), "h:mm a")}
        </time>
        <span className="font-semibold">{label?.name ?? "Unknown sender"}</span>
        {label?.address && <span className="text-muted-foreground">· {label.address}</span>}
        <span
          data-testid="hold-age"
          data-tone={tone}
          className={cn("ml-auto rounded-full px-2 text-xs tabular-nums", TONE_CLASS[tone])}
        >
          {formatAge(age)}
        </span>
      </header>
      {run?.inbound_preview && (
        <p className="mt-2 flex gap-2">
          <span aria-hidden className="text-muted-foreground">◀</span>
          <span>{run.inbound_preview}</span>
        </p>
      )}
      <p className="mt-2 flex gap-2">
        <span aria-hidden className="text-sky-600">●</span>
        <span>
          {hold.reason}
          {why ? ` · ${why}` : ""}
        </span>
      </p>
      <Phase2Actions />
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

export function HoldsRail({
  holds,
  labels,
  nowMs,
}: {
  holds: readonly OpenHold<RunWithSteps>[];
  labels: ReadonlyMap<string, RunLabel>;
  nowMs: number;
}) {
  return (
    <aside aria-label="Holds" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">
        Holds <span className="text-muted-foreground">({holds.length})</span>
      </h2>
      {holds.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          No open holds.
        </p>
      ) : (
        holds.map((hold) => (
          <HoldCard key={hold.id} hold={hold} label={labels.get(hold.id)} nowMs={nowMs} />
        ))
      )}
      <ShadowScorecard />
    </aside>
  );
}
