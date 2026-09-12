"use client";

import { useEffect, useState } from "react";
import { SandraRecordingPlayer } from "@/app/(dashboard)/leads/[id]/sandra-recording-player";
import { Button } from "@/components/ui/button";

type Artifacts = {
  recordingStatus: string; durationSeconds: number | null;
  transcriptStatus: string; transcript: string | null;
  summaryStatus: string; summary: string | null;
};

/** Only mounted for expanded lead details. Refresh metadata without replacing a playing audio element. */
export function MyLeadCallArtifacts({ callActivityId }: { callActivityId: string }) {
  const [artifacts, setArtifacts] = useState<Artifacts | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/leads/calls/${encodeURIComponent(callActivityId)}/artifacts`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error("Artifact lookup failed");
        const data: Artifacts = await response.json();
        if (!disposed) { setArtifacts(data); setError(false); }
      } catch {
        if (!disposed) setError(true);
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const foreground = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [callActivityId, revision]);

  return <div className="col-span-full min-w-0 space-y-2 whitespace-normal" aria-label="Call artifacts">
    {error && <p role="status">Call details could not be refreshed. Try again.</p>}
    {!artifacts && !error && <p role="status">Loading recording and summary…</p>}
    {artifacts && <>
      {artifacts.recordingStatus === "available"
        ? <SandraRecordingPlayer key={callActivityId} callActivityId={callActivityId} durationSeconds={artifacts.durationSeconds ?? undefined} />
        : <p role="status">{artifactLabel("Recording", artifacts.recordingStatus)}</p>}
      {artifacts.summaryStatus === "available" && artifacts.summary
        ? <section aria-label="AI summary"><h4 className="font-semibold">AI summary</h4><p className="whitespace-pre-wrap">{artifacts.summary}</p></section>
        : <p role="status">{artifactLabel("Summary", artifacts.summaryStatus)}</p>}
      {artifacts.transcriptStatus === "available" && artifacts.transcript
        ? <details><summary>Transcript</summary><p className="max-h-80 overflow-y-auto whitespace-pre-wrap">{artifacts.transcript}</p></details>
        : <p role="status">{artifactLabel("Transcript", artifacts.transcriptStatus)}</p>}
    </>}
    <Button type="button" variant="link" size="xs" onClick={() => setRevision(r => r + 1)}>Refresh call details</Button>
  </div>;
}

function artifactLabel(name: string, state: string) {
  if (state === "pending") return `${name} processing`;
  if (state === "failed") return `${name} processing failed. Other call details remain available.`;
  if (state === "none") return name === "Recording" ? "No recording captured" : `${name} not available`;
  return `${name} status unavailable`;
}
