"use client";

import { Droplet } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { changeDripAction, cancelEnrollment, pauseEnrollmentAction, resumeEnrollmentAction, retrySequenceStepAction, startDripForLeads } from "@/app/(dashboard)/sequences/actions";
import { StartDripPicker, type PickResult } from "@/components/sequences/start-drip-picker";
import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";
import { listDripProgress, type DripProgress } from "@/lib/sequences/drip-progress";
import { createClient } from "@/lib/supabase/client";

function dateLabel(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function DripCard({ propertyId, initialProgress }: { propertyId: string; initialProgress?: DripProgress | null }) {
  const router = useRouter();
  const [progress, setProgress] = useState<DripProgress | null>(initialProgress ?? null);
  const [loading, setLoading] = useState(initialProgress === undefined);
  const [loadError, setLoadError] = useState(false);
  const [pending, startTransition] = useTransition();

  async function refresh() {
    try {
      const rows = await listDripProgress(createClient(), [propertyId]);
      setProgress(rows[0] ?? null);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialProgress !== undefined) return;
    let current = true;
    void listDripProgress(createClient(), [propertyId]).then((rows) => {
      if (current) { setProgress(rows[0] ?? null); setLoadError(false); setLoading(false); }
    }).catch(() => { if (current) { setLoadError(true); setLoading(false); } });
    return () => { current = false; };
    // Fixture progress is deliberately stable; live data reloads when the lead changes.
  }, [propertyId, initialProgress]);

  async function choose(sequenceId: string): Promise<PickResult> {
    const changing = Boolean(progress && ["active", "paused"].includes(progress.enrollmentStatus));
    const result = changing && progress
      ? await changeDripAction(progress.enrollmentId, sequenceId)
      : await startDripForLeads(sequenceId, [propertyId]);
    if (changing) {
      await refresh();
      router.refresh();
    }
    if (!result.ok) return { status: "failed", reason: result.error.message, saved: false };
    const outcome = "results" in result.data ? result.data.results[0] : result.data;
    if (!changing && outcome.status === "enrolled") {
      await refresh();
      router.refresh();
    }
    return { ...outcome, saved: false };
  }

  function mutate(kind: "pause" | "resume" | "retry" | "stop") {
    if (!progress) return;
    if (kind === "stop" && !window.confirm("Stop this drip? No more texts will be sent.")) return;
    startTransition(async () => {
      const result = await callAction(kind === "pause" ? pauseEnrollmentAction(progress.enrollmentId) : kind === "resume" ? resumeEnrollmentAction(progress.enrollmentId) : kind === "retry" ? retrySequenceStepAction(progress.enrollmentId) : cancelEnrollment(progress.enrollmentId), {
        successMessage: kind === "pause" ? "Drip paused" : kind === "resume" ? "Drip resumed" : kind === "retry" ? "Step retried" : "Drip stopped",
        fallbackMessage: kind === "pause" ? "Could not pause the drip" : kind === "resume" ? "Could not resume the drip" : kind === "retry" ? "Could not retry the step" : "Could not stop the drip",
      });
      if (result.ok) { await refresh(); router.refresh(); }
    });
  }

  const live = progress && ["active", "paused"].includes(progress.enrollmentStatus);
  const needsRetry = progress?.enrollmentStatus === "paused" && ["provider_failed", "reconciliation_required"].includes(progress.pauseReason ?? "");

  return (
    <section className="rounded-xl border border-sky-200 bg-card p-3.5" aria-label="Drip" data-testid="lead-drip-card">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold"><Droplet className="size-3.5 text-sky-700" />Drip</h3>
      {loading ? <p className="text-xs text-muted-foreground">Loading drip…</p> : loadError ? <div className="text-xs">Could not load drip. <Button variant="ghost" size="sm" onClick={() => void refresh()}>Retry</Button></div> : progress ? (
        <div className="space-y-2 text-xs">
          <div className="font-semibold">{progress.sequenceName}</div>
          <div className="text-muted-foreground">text {progress.step} of {progress.totalSteps}</div>
          {progress.status !== "Waiting" ? <div className="font-medium">{progress.status ?? "Paused"}</div> : null}
          {progress.reason ? <p className="text-muted-foreground">{progress.reason}</p> : null}
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">Next text</span><span>{progress.nextTextAt ? dateLabel(progress.nextTextAt) : "—"}</span></div>
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">Last text sent</span><span>{progress.lastText ? dateLabel(progress.lastText.sentAt) : "—"}</span></div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {progress.enrollmentStatus === "active" ? <Button variant="outline" size="sm" disabled={pending} onClick={() => mutate("pause")}>Pause</Button> : null}
            {progress.enrollmentStatus === "paused" ? <Button variant="outline" size="sm" disabled={pending} onClick={() => mutate(needsRetry ? "retry" : "resume")}>{needsRetry ? "Retry" : "Resume"}</Button> : null}
            <StartDripPicker triggerLabel={live ? "Switch drip" : "Start drip"} triggerTone={live ? "outline" : "primary"} onChoose={choose} disabled={pending} />
            {live ? <Button variant="outline" size="sm" className="text-destructive" disabled={pending} onClick={() => mutate("stop")}>Stop</Button> : null}
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-xs"><p className="text-muted-foreground">Not in a drip</p><StartDripPicker triggerLabel="Start drip" triggerTone="primary" onChoose={choose} disabled={pending} /></div>
      )}
    </section>
  );
}
