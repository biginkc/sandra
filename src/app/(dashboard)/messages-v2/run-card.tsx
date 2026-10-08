"use client";

import { format } from "date-fns/format";
import { ExternalLink } from "lucide-react";

import { cn } from "@/lib/utils";

import { readJevScores, replyPersona } from "./step-format";
import type { PipelineRunStep, RunLabel, RunWithSteps } from "./types";

const ENTER = "animate-in fade-in slide-in-from-top-1 duration-300";

const DRIP_ROUTE_LABELS: Record<string, string> = {
  maybe_later: "Maybe later",
  check_in_60: "Check in every 60 days",
  listed_not_selling: "Listed, not selling",
  hot_book_appointment: "Book appointment",
};

/** "Maybe later, first text Nov 6" for an applied auto-drip step, else null. */
export function dripEnrollmentSummary(step: PipelineRunStep): string | null {
  if (step.name !== "drip_enrolled" || step.result !== "applied") return null;
  const route = typeof step.detail?.route === "string" ? step.detail.route : null;
  const label = route ? (DRIP_ROUTE_LABELS[route] ?? route) : null;
  const at = typeof step.detail?.firstSendNotBefore === "string" ? new Date(step.detail.firstSendNotBefore) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `first text ${format(at, "MMM d")}` : null;
  const parts = [label, when].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function StepLine({ step }: { step: PipelineRunStep }) {
  const base = cn("flex items-baseline gap-2 text-sm", ENTER);
  switch (step.kind) {
    case "jev": {
      const scores = readJevScores(step.detail);
      return (
        <li data-testid="step-jev" className={base}>
          <span aria-hidden className="text-sky-600">
            ●
          </span>
          <span className="font-medium">Jev</span>
          {scores.length === 0 ? (
            <span className="text-muted-foreground">{step.name}</span>
          ) : (
            scores.map((s) => (
              <span key={s.label} className="tabular-nums">
                {s.label} {s.pct}%
              </span>
            ))
          )}
        </li>
      );
    }
    case "threshold":
      return (
        <li data-testid="step-threshold" className={base}>
          <span aria-hidden className="text-sky-600">
            ●
          </span>
          <span>
            {step.name}{" "}
            <span className="text-muted-foreground">{step.result}</span>
          </span>
        </li>
      );
    case "action":
      return (
        <li data-testid="step-action" className={base}>
          <span aria-hidden className="text-emerald-600">
            ✔
          </span>
          <span>{step.name}</span>
          {step.result !== "applied" && (
            <span className="text-muted-foreground">({step.result})</span>
          )}
          {dripEnrollmentSummary(step) && (
            <span data-testid="drip-enrollment" className="text-muted-foreground">
              {dripEnrollmentSummary(step)}
            </span>
          )}
        </li>
      );
    case "reply": {
      const persona = replyPersona(step);
      return (
        <li data-testid="step-reply" className={base}>
          <span aria-hidden className="text-emerald-600">
            ▶
          </span>
          <span>
            {step.name}{" "}
            <span className="text-muted-foreground">
              ({step.result}
              {persona ? `, as ${persona}` : ""})
            </span>
          </span>
        </li>
      );
    }
    case "gate":
    case "hold":
      return (
        <li data-testid={`step-${step.kind}`} className={base}>
          <span aria-hidden className="text-amber-600">
            ■
          </span>
          <span>
            {step.name}{" "}
            <span className="text-muted-foreground">({step.result})</span>
          </span>
        </li>
      );
    case "shadow":
      return (
        <li
          data-testid="step-shadow"
          className={cn(base, "text-muted-foreground")}
        >
          <span aria-hidden>○</span>
          <span>would → {step.name}</span>
        </li>
      );
  }
}

/**
 * Where "open thread" goes. The lead page admits both owners and
 * Acquisitions callers; the legacy /messages inbox denies Acquisitions, so it
 * is only offered to owners when there is no property to open.
 */
export function openThreadHref(
  run: Pick<RunWithSteps, "property_id" | "conversation_id">,
  isOwner: boolean,
): string | null {
  if (run.property_id) return `/leads/${encodeURIComponent(run.property_id)}`;
  if (run.conversation_id && isOwner) {
    return `/messages?thread=${encodeURIComponent(run.conversation_id)}`;
  }
  return null;
}

export function RunCard({
  run,
  label,
  isOwner = false,
}: {
  run: RunWithSteps;
  label: RunLabel | undefined;
  isOwner?: boolean;
}) {
  const threadHref = openThreadHref(run, isOwner);
  const name = label?.name ?? "Unknown sender";
  const passedGates = run.steps.filter(
    (s) => s.kind === "gate" && s.result === "pass",
  );
  const visible = run.steps.filter(
    (s) => !(s.kind === "gate" && s.result === "pass"),
  );
  const running = run.status === "running";
  const autoDripped = run.steps.some((st) => dripEnrollmentSummary(st) !== null);

  return (
    <article
      data-testid="run-card"
      data-status={run.status}
      className={cn(
        "rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10",
        ENTER,
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {running && (
          <span
            data-testid="run-pulse"
            aria-label="Running"
            className="size-2 animate-pulse self-center rounded-full bg-sky-500"
          />
        )}
        <time
          suppressHydrationWarning
          dateTime={run.started_at}
          className="text-xs tabular-nums text-muted-foreground"
        >
          {format(new Date(run.started_at), "h:mm:ss a")}
        </time>
        <span className="font-semibold">{name}</span>
        {label?.address && (
          <span className="text-muted-foreground">· {label.address}</span>
        )}
        <span className="ml-auto rounded-full bg-secondary px-2 text-xs uppercase tracking-wide text-muted-foreground">
          {run.mode}
        </span>
      </header>

      {run.inbound_preview && (
        <p className="mt-2 flex gap-2">
          <span aria-hidden className="text-muted-foreground">
            ◀
          </span>
          <span>{run.inbound_preview}</span>
        </p>
      )}

      <ul className="mt-2 space-y-1">
        {visible.map((step) => (
          <StepLine key={step.id} step={step} />
        ))}
        {passedGates.length > 0 && (
          <li
            data-testid="gates-passed"
            className="text-xs text-muted-foreground"
          >
            {passedGates.length} gate{passedGates.length === 1 ? "" : "s"}{" "}
            passed
          </li>
        )}
      </ul>

      {autoDripped && run.property_id && (
        <p data-testid="drip-stop-hint" className="mt-2 text-xs text-muted-foreground">
          Auto-enrolled in a drip.{" "}
          <a
            href={`/leads/${encodeURIComponent(run.property_id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Stop it from the lead page
          </a>
        </p>
      )}

      {threadHref && (
        <a
          href={threadHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          open thread <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </article>
  );
}
