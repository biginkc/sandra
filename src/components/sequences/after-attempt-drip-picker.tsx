"use client";

import { useEffect, useRef, useState } from "react";
import { changeDripAction, startDripForLeads, type DripChoice } from "@/app/(dashboard)/sequences/actions";
import { listDripProgress, type DripProgress } from "@/lib/sequences/drip-progress";
import { createClient } from "@/lib/supabase/client";
import { StartDripPicker, type PickResult } from "./start-drip-picker";

/** The attempt is already saved; enrollment must not rewrite its outcome. */
export function AfterAttemptDripPicker({ propertyId, previewChoices, onDripChanged, onEnrolled }: {
  propertyId: string;
  previewChoices?: DripChoice[];
  onDripChanged?: () => void;
  onEnrolled: () => void;
}) {
  const [progress, setProgress] = useState<DripProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const messageRef = useRef<HTMLParagraphElement>(null);
  const pending = useRef(false);
  const live = progress && ["active", "paused"].includes(progress.enrollmentStatus) ? progress : null;

  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => listDripProgress(createClient(), [propertyId])).then(rows => {
      if (current) { setProgress(rows[0] ?? null); setLoadError(false); }
    }).catch(() => { if (current) setLoadError(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [propertyId, retry]);

  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);

  async function choose(sequenceId: string, switching = false): Promise<PickResult> {
    if (pending.current || loading || loadError) return { status: "failed", reason: "Wait for the current drip to load." };
    if (live?.sequenceId === sequenceId) return { status: "skipped", reason: "This is already the current drip." };
    pending.current = true;
    setBusy(true);
    setMessage("");
    let result: PickResult;
    try {
      if (live) {
        const response = await changeDripAction(live.enrollmentId, sequenceId);
        result = response.ok ? response.data : { status: "failed", reason: response.error.message };
      } else {
        const response = await startDripForLeads(sequenceId, [propertyId]);
        result = response.ok ? response.data.results[0] ?? { status: "failed", reason: "Could not start drip." }
          : { status: "failed", reason: response.error.message };
      }
    } catch {
      result = { status: "failed", reason: "Could not update the drip. Check the current drip before retrying." };
    }
    // A replacement can stop the old drip even when enrollment fails. Reload on
    // every result, including transport errors, before allowing another choice.
    try {
      const rows = await listDripProgress(createClient(), [propertyId]);
      setProgress(rows[0] ?? null);
      setLoadError(false);
    } catch { setLoadError(true); }
    setSelectedId(null);
    pending.current = false;
    setBusy(false);
    onDripChanged?.();
    if (result.status === "enrolled") onEnrolled();
    else if (switching) setMessage(`Attempt saved. Drip not started: ${result.reason}`);
    return result;
  }

  return <div className="space-y-2">
    {message && <p ref={messageRef} role="alert" tabIndex={-1} className="rounded-md border border-destructive p-2 text-sm text-destructive">{message}</p>}
    {loading ? <p role="status" className="text-sm">Loading current drip…</p>
      : loadError ? <div role="alert" className="text-sm">Could not load the current drip. <button type="button" className="underline" disabled={busy} onClick={() => { setLoading(true); setSelectedId(null); setRetry(value => value + 1); }}>Retry current drip</button></div>
      : <p className="text-sm">{live ? <>Current drip: <strong>{live.sequenceName}</strong> ({live.enrollmentStatus}). Choose a different drip, then confirm the switch.</> : "Not currently in an active or paused drip."}</p>}
    {live && !loadError && <button type="button" className="rounded-md border px-3 py-2 text-sm font-medium" disabled={busy || loading || !selectedId || selectedId === live.sequenceId} onClick={() => selectedId && void choose(selectedId, true)}>{busy ? "Switching drip…" : "Switch to selected drip"}</button>}
    <StartDripPicker inline previewChoices={previewChoices} disabled={loading || loadError || busy}
      selectionOnly={Boolean(live)} selectedSequenceId={selectedId}
      onSelect={setSelectedId} onChoose={choose} />
  </div>;
}
