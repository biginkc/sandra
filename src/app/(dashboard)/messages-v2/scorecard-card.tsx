"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { isHumanOnlyOutcome } from "@/lib/sms-classification/thresholds";
import { cn } from "@/lib/utils";

import { lunaOutcomeLabel } from "./luna-labels";
import {
  buildLunaStats,
  buildScorecard,
  fetchLunaStatRows,
  fetchScorecardRows,
  formatRuleText,
  MIN_SUGGESTION_SAMPLES,
  TARGET_AGREEMENT_PERCENT,
  type LunaStatRow,
  type LunaStats,
  type OutcomeScorecard,
  type RouteAgreement,
  type RpcClient,
  type ScorecardRow,
  type ScorecardWindow,
} from "./scorecard";

const POLL_MS = 60_000;
const WINDOWS: ScorecardWindow[] = [7, 30];

export type ScorecardLoader = (
  orgId: string,
  windowDays: ScorecardWindow,
) => Promise<ScorecardRow[]>;

export type LunaStatsLoader = (
  orgId: string,
  windowDays: ScorecardWindow,
) => Promise<LunaStatRow[]>;

const defaultLunaLoad: LunaStatsLoader = (orgId, windowDays) =>
  fetchLunaStatRows(createClient() as unknown as RpcClient, orgId, windowDays);

const defaultLoad: ScorecardLoader = (orgId, windowDays) =>
  fetchScorecardRows(createClient() as unknown as RpcClient, orgId, windowDays);

const pct = (r: number | null) =>
  r === null ? "n/a" : `${Math.round(r * 100)}%`;

const routePct = (r: RouteAgreement) =>
  r.n > 0 ? `${Math.round((r.agreed / r.n) * 100)}% (n=${r.n})` : "n/a (n=0)";

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
      {detail && (
        <span className="text-xs text-muted-foreground">{detail}</span>
      )}
    </div>
  );
}

function OutcomeRow({ o }: { o: OutcomeScorecard }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const s = o.suggestion;

  const copy = async () => {
    if (s.kind !== "suggested") return;
    try {
      await navigator.clipboard.writeText(
        formatRuleText(o.outcome, s.threshold),
      );
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <li
      data-testid={`scorecard-${o.outcome}`}
      className="flex flex-col gap-2 rounded-lg border p-3 text-sm"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="font-medium">{o.outcome}</h4>
        <span className="tabular-nums">{o.runs} runs</span>
        <span className="tabular-nums text-muted-foreground">
          {o.autoApplied} auto
        </span>
        <span className="tabular-nums text-muted-foreground">
          {o.held} held
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>
            {o.threshold === null
              ? "no threshold"
              : `threshold ${o.threshold.toFixed(3)}`}
          </span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5",
              o.automationEnabled && !isHumanOnlyOutcome(o.outcome)
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                : "bg-secondary",
            )}
          >
            {isHumanOnlyOutcome(o.outcome)
              ? "always human (locked)"
              : o.automationEnabled === null
                ? "automation not set"
                : o.automationEnabled
                  ? "automation on"
                  : "automation off"}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <Stat
          label="Auto agreement"
          value={pct(o.autoAgreementRate)}
          detail={
            o.autoSettled > 0
              ? `${o.autoAgreed}/${o.autoSettled} settled`
              : "none settled yet"
          }
        />
        <Stat
          label="Held agreement"
          value={pct(o.heldAgreementRate)}
          detail={
            o.heldDecided > 0
              ? `${o.heldAgreed}/${o.heldDecided} decided`
              : "none decided yet"
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {s.kind === "insufficient" && (
          <span className="text-muted-foreground">
            Insufficient data ({s.samples}/{MIN_SUGGESTION_SAMPLES})
          </span>
        )}
        {s.kind === "none" && (
          <span className="text-muted-foreground">
            No cutoff reaches {TARGET_AGREEMENT_PERCENT}% agreement ({s.samples}{" "}
            samples)
          </span>
        )}
        {s.kind === "keep_current" && (
          <span className="text-muted-foreground">
            {s.currentTail
              ? `No qualifying cutoff; current tail at ${((s.currentTail.agreed / s.currentTail.n) * 100).toFixed(1)}% (n=${s.currentTail.n})`
              : null}
            {!s.currentTail && (
              <>
                Keep current threshold: no lower cutoff has{" "}
                {MIN_SUGGESTION_SAMPLES}+ samples at {TARGET_AGREEMENT_PERCENT}%
                in its own band ({s.samples} samples)
              </>
            )}
          </span>
        )}
        {s.kind === "suggested" && (
          <>
            <span>
              <span className="font-medium">
                Suggested ≥ {s.threshold.toFixed(3)}
              </span>{" "}
              {s.direction === "loosens" && (
                <span className="text-xs font-medium text-amber-800 dark:text-amber-200">
                  loosens current
                </span>
              )}{" "}
              <span className="text-xs text-muted-foreground">
                (auto {routePct(s.auto)}, held {routePct(s.held)}, total n=
                {s.total})
              </span>
            </span>
            {s.direction !== "same" && (
              <Button type="button" size="sm" variant="outline" onClick={copy}>
                Copy for approval
              </Button>
            )}
            {copyState === "copied" && (
              <span
                role="status"
                className="text-xs text-emerald-700 dark:text-emerald-300"
              >
                Copied
              </span>
            )}
            {copyState === "failed" && (
              <span
                role="status"
                className="text-xs text-red-700 dark:text-red-300"
              >
                Copy failed
              </span>
            )}
          </>
        )}
      </div>
    </li>
  );
}

type LunaWindowState = LunaStats | "error" | null;

function LunaWindow({ days, state }: { days: ScorecardWindow; state: LunaWindowState }) {
  return (
    <div data-testid={`luna-stats-${days}`} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
      <h5 className="font-medium">Last {days} days</h5>
      {state === null ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : state === "error" ? (
        <p role="alert" className="text-xs text-amber-900 dark:text-amber-200">
          Luna stats unavailable
        </p>
      ) : (
        <>
          <Stat label="Suggestions shown" value={String(state.shown)} />
          <Stat
            label="Accepted"
            value={pct(state.acceptedRate)}
            detail={`${state.accepted}/${state.shown}`}
          />
          <Stat label="Rejected" value={String(state.rejected)} />
          <Stat label="Agreed manually" value={String(state.agreedManually)} />
          <Stat label="Still open" value={String(state.open)} />
          {state.byOutcome.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              {state.byOutcome.map((o) => (
                <li key={o.outcome} data-testid={`luna-outcome-${days}-${o.outcome}`}>
                  {lunaOutcomeLabel(o.outcome)}: {o.shown} shown, {o.accepted} accepted
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** Luna suggestion stats, 7d and 30d side by side. A failed window shows "unavailable", never zeros. */
function LunaStatsRow({
  orgId,
  load,
  pollMs,
}: {
  orgId: string;
  load: LunaStatsLoader;
  pollMs: number;
}) {
  const [states, setStates] = useState<Record<ScorecardWindow, LunaWindowState>>({ 7: null, 30: null });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const refresh = useCallback(async () => {
    await Promise.all(
      WINDOWS.map(async (d) => {
        let next: LunaWindowState;
        try {
          next = buildLunaStats(await loadRef.current(orgId, d));
        } catch {
          next = "error";
        }
        setStates((prev) => ({ ...prev, [d]: next }));
      }),
    );
  }, [orgId]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    }, pollMs);
    return () => window.clearInterval(id);
  }, [refresh, pollMs]);

  return (
    <div data-testid="luna-stats" className="flex flex-col gap-2">
      <h4 className="font-medium">Luna suggestions</h4>
      <div className="grid gap-2 md:grid-cols-2">
        {WINDOWS.map((d) => (
          <LunaWindow key={d} days={d} state={states[d]} />
        ))}
      </div>
    </div>
  );
}

/**
 * Shadow scorecard: how often Jev's per-outcome calls survive human review,
 * and the lowest confidence cutoff that would have held >= 95% agreement.
 * Display and suggestion only: nothing here writes a threshold or a flag.
 */
export function ScorecardCard({
  orgId,
  initialRows = null,
  initialWindow = 7,
  load = defaultLoad,
  pollMs = POLL_MS,
  lunaEnabled = false,
  lunaLoad = defaultLunaLoad,
}: {
  orgId: string;
  /** Server-loaded rows for `initialWindow`; null/undefined means load on mount. */
  initialRows?: ScorecardRow[] | null;
  initialWindow?: ScorecardWindow;
  load?: ScorecardLoader;
  pollMs?: number;
  /** Show the Luna suggestions row (the page passes the feature flag). */
  lunaEnabled?: boolean;
  lunaLoad?: LunaStatsLoader;
}) {
  const [windowDays, setWindowDays] = useState<ScorecardWindow>(initialWindow);
  const [rows, setRows] = useState<ScorecardRow[] | null>(initialRows);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const windowRef = useRef(windowDays);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const refresh = useCallback(
    async (days: ScorecardWindow) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const next = await loadRef.current(orgId, days);
        if (mine !== seq.current) return; // a newer request superseded this one
        setRows(next);
        setError(false);
      } catch {
        if (mine === seq.current) setError(true);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [orgId],
  );

  const hadInitial = useRef(initialRows !== null && initialRows !== undefined);
  useEffect(() => {
    if (!hadInitial.current) void refresh(windowRef.current);
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      void refresh(windowRef.current);
    }, pollMs);
    return () => window.clearInterval(id);
  }, [refresh, pollMs]);

  const pick = (days: ScorecardWindow) => {
    if (days === windowRef.current) return;
    windowRef.current = days;
    setWindowDays(days);
    void refresh(days);
  };

  const outcomes = useMemo(() => (rows ? buildScorecard(rows) : null), [rows]);

  return (
    <section
      aria-label="Shadow scorecard"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="font-medium">Shadow scorecard</h3>
        <div role="group" aria-label="Window" className="flex gap-1">
          {WINDOWS.map((d) => (
            <Button
              key={d}
              type="button"
              size="sm"
              variant={d === windowDays ? "default" : "outline"}
              aria-pressed={d === windowDays}
              onClick={() => pick(d)}
            >
              {d}d
            </Button>
          ))}
        </div>
        <p className="ml-auto text-xs text-muted-foreground">
          Suggestion only: nothing is applied. Auto calls count as settled after
          72h without a human correction.
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          Scorecard unavailable
          {outcomes ? "; showing the last loaded numbers" : ""}.
        </p>
      )}
      {outcomes ? (
        <ul
          className={cn("grid gap-2 md:grid-cols-2", loading && "opacity-70")}
          aria-busy={loading}
        >
          {outcomes.map((o) => (
            <OutcomeRow key={o.outcome} o={o} />
          ))}
        </ul>
      ) : (
        !error && (
          <p className="text-sm text-muted-foreground">Loading scorecard…</p>
        )
      )}
      {lunaEnabled && <LunaStatsRow orgId={orgId} load={lunaLoad} pollMs={pollMs} />}
    </section>
  );
}
