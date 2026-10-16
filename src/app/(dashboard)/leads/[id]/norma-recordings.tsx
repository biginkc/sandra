"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

type Recording = { attempt: number; state?: string };
const availability: Record<string, string> = {
  unchecked: "Recording availability has not been checked. You can try playback.",
  pending: "Recording is still processing or awaiting an availability check.",
  reported_available: "Recording available.",
  not_recorded: "The provider reports this call was not recorded.",
  unavailable: "No recording was available after repeated checks.",
  failed: "Recording availability could not be checked. Playback may still work; try again later.",
};
type State = { kind: "idle" | "loading" } | { kind: "error"; message: string } | { kind: "ready"; recordings: Recording[] };

/** Audio stays behind the dashboard session; provider URLs and keys never reach the browser. */
export function NormaRecordings({ requestId }: { requestId: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [failed, setFailed] = useState<number[]>([]);
  const [revision, setRevision] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  async function load() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: "loading" });
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`/api/norma/requests/${encodeURIComponent(requestId)}/recordings`, { cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => { throw new Error("Unable to load recordings. Try again."); });
      if (!body || typeof body !== "object") throw new Error("Unable to load recordings");
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to load recordings");
      if (!Array.isArray(body.recordings) || !body.recordings.every((item: { attempt?: unknown }) => item && (item.attempt === 1 || item.attempt === 2))) {
        throw new Error("Unable to load recordings");
      }
      setFailed([]);
      setRevision((value) => value + 1);
      setState({ kind: "ready", recordings: body.recordings.filter((item: Recording, index: number, items: Recording[]) => items.findIndex((other) => other.attempt === item.attempt) === index) });
    } catch (error) {
      if (controllerRef.current !== controller) return;
      setState({ kind: "error", message: controller.signal.aborted ? "Recording request timed out. Try again." : error instanceof Error ? error.message : "Unable to load recordings" });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  return (
    <div className="w-full space-y-2" data-testid="norma-recordings">
      {state.kind === "error" ? <p role="alert">{state.message}</p> : null}
      {state.kind === "ready" && state.recordings.length === 0 ? <p>No recording is available for this call yet.</p> : null}
      {state.kind === "ready" ? state.recordings.map(({ attempt, state: recordingState }) => (
        <div key={attempt} className="space-y-1">
          <p className="font-medium">Norma recording · Attempt {attempt}</p>
          <p>{typeof recordingState === "string" && Object.hasOwn(availability, recordingState) ? availability[recordingState] : availability.unchecked}</p>
          <audio key={`${attempt}-${revision}`} controls preload="none" aria-label={`Norma recording, attempt ${attempt}`} className="w-full max-w-full"
            src={`/api/norma/requests/${encodeURIComponent(requestId)}/recordings/${attempt}`}
            onError={() => setFailed((values) => values.includes(attempt) ? values : [...values, attempt])} />
          {failed.includes(attempt) ? <p role="alert">Recording unavailable. It may still be processing, or this call was not recorded. Try again later.</p> : null}
        </div>
      )) : null}
      <Button type="button" size="sm" variant="outline" disabled={state.kind === "loading"} onClick={() => void load()}>
        {state.kind === "loading" ? "Loading recordings…" : state.kind === "idle" ? "Load Norma recordings" : "Reload recordings"}
      </Button>
    </div>
  );
}
