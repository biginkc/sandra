"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  historyMoney,
  safeHistoryRecording,
  mergeAcquisitionHistory,
  type AcquisitionHistoryFact,
  type AcquisitionHistoryResult,
  type AcquisitionHistoryPage,
} from "@/lib/leads/acquisition-history";
import { loadLeadAcquisitionHistory } from "./acquisition-history-actions";
const empty: AcquisitionHistoryPage = {
  rows: [],
  hasMore: false,
  cursor: null,
};
export function useAcquisitionHistory(
  propertyId: string,
  initial?: AcquisitionHistoryResult,
) {
  const [page, setPage] = useState(initial?.ok ? initial.page : empty);
  const [error, setError] = useState(
    initial && !initial.ok ? initial.message : null,
  );
  const [pending, startTransition] = useTransition();
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    setPage(initial?.ok ? initial.page : empty);
    setError(initial && !initial.ok ? initial.message : null);
    return () => {
      generation.current++;
    };
  }, [propertyId, initial]);
  const load = (more: boolean) => {
    if (busy.current) return;
    busy.current = true;
    const current = generation.current;
    startTransition(async () => {
      try {
        const result = await loadLeadAcquisitionHistory(
          propertyId,
          more ? page.cursor : null,
        );
        if (current !== generation.current) return;
        if (result.ok) {
          setPage((previous) => ({
            ...result.page,
            rows: more
              ? mergeAcquisitionHistory(previous.rows, result.page.rows)
              : result.page.rows,
          }));
          setError(null);
        } else setError(result.message);
      } catch {
        if (current === generation.current)
          setError("Outreach and offer history could not be loaded. Retry.");
      } finally {
        if (current === generation.current) busy.current = false;
      }
    });
  };
  return {
    page,
    error,
    pending,
    retry: () => load(false),
    loadMore: () => load(true),
  };
}
const date = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "long",
  timeZone: "America/Chicago",
});
export function AcquisitionHistoryCard({
  fact,
  actor,
  embedded = false,
}: {
  fact: AcquisitionHistoryFact;
  actor: string;
  embedded?: boolean;
}) {
  const recording =
    fact.kind === "attempt" ? safeHistoryRecording(fact.recordingUrl) : null;
  return (
    <article
      className={
        embedded
          ? "mt-3 space-y-1 border-t border-border pt-3 text-sm"
          : "max-w-[560px] space-y-1 rounded-lg border border-border bg-background p-3 text-sm"
      }
      data-testid={`lead-acquisition-${fact.kind}-${fact.id}`}
    >
      {embedded && (
        <p className="text-xs font-semibold text-muted-foreground">
          Recorded rep outcome
        </p>
      )}
      <p className="font-semibold">
        {fact.kind === "attempt"
          ? ({
              reached: "Reached",
              no_answer: "No answer",
              wrong_number: "Wrong number",
            }[fact.outcome ?? ""] ?? "Outcome pending")
          : "Offer recorded"}
      </p>
      <p className="text-xs text-muted-foreground">
        {actor} ·{" "}
        <time dateTime={fact.at}>{date.format(new Date(fact.at))}</time>
      </p>
      {fact.kind === "attempt" ? (
        <>
          {fact.outcome === "no_answer" && fact.followUpObligationId && (
            <div className="rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-xs dark:border-amber-900 dark:bg-amber-950/30">
              <p className="font-medium">
                Follow-up {fact.followUpStatus?.replaceAll("_", " ") ?? "status unavailable"}
              </p>
              {fact.followUpMessage && <p className="mt-0.5 text-muted-foreground">{fact.followUpMessage}</p>}
            </div>
          )}
          <p>
            {{
              dialpad: "DialPad",
              manual: "Manual outreach",
              sandra: "Sandra",
            }[fact.source] ?? "Outreach"}{" "}
            · {fact.attemptKind === "call" ? "Call" : "Non-call outreach"}
          </p>
          {fact.note && (
            <p className="whitespace-pre-wrap break-words">{fact.note}</p>
          )}
          {recording ? (
            <a
              href={recording}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Recording
            </a>
          ) : !embedded ? (
            <p className="text-xs text-muted-foreground">
              No recording link added
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p>
            {historyMoney(fact.amountCents)} ·{" "}
            {{
              verbal: "Verbal",
              email_text: "Email / text",
              dropbox_sign: "Dropbox Sign (logged)",
            }[fact.method] ?? "Offer"}
          </p>
          <p>
            Follow-up:{" "}
            <time dateTime={fact.followUpAt}>
              {date.format(new Date(fact.followUpAt))}
            </time>
          </p>
          <p>
            Outcome: {fact.outcome.replaceAll("_", " ")}
            {fact.outcomeAt && (
              <>
                {" "}
                ·{" "}
                <time dateTime={fact.outcomeAt}>
                  {date.format(new Date(fact.outcomeAt))}
                </time>
              </>
            )}
          </p>
        </>
      )}
    </article>
  );
}
