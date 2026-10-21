"use client";

import { CheckIcon, GaugeIcon, PauseIcon, PlayIcon, SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SMS_PACING_SECONDS } from "@/lib/messaging/pacing";

import {
  applyCampaignCadenceChange,
  pauseCampaignSends,
  previewCampaignCadenceChange,
  resumeCampaignSends,
  type CampaignCadenceChangeResult,
  type CampaignQueuePauseResult,
} from "../actions";

type Props = {
  campaignId: string;
  campaignStatus: string;
  queuedCount: number;
  pausedCount: number;
  pendingCount: number;
  currentPaceSeconds: number | null;
};

export function CampaignCadenceControl({
  campaignId,
  campaignStatus,
  queuedCount,
  pausedCount,
  pendingCount,
  currentPaceSeconds,
}: Props) {
  const router = useRouter();
  const [pace, setPace] = useState(
    String(currentPaceSeconds ?? SMS_PACING_SECONDS.savedCampaignDefault),
  );
  const [preview, setPreview] = useState<CampaignCadenceChangeResult | null>(
    null,
  );
  const [applied, setApplied] = useState<CampaignCadenceChangeResult | null>(
    null,
  );
  const [paused, setPaused] = useState<CampaignQueuePauseResult | null>(null);
  const [resumed, setResumed] = useState<CampaignCadenceChangeResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Every action outcome is surfaced: an ok:false result OR a thrown/rejected
  // server action (network drop, function timeout) shows a visible error.
  function runAction<T>(
    label: string,
    action: () => Promise<
      { ok: true; data: T } | { ok: false; error: { message: string } }
    >,
    onOk: (data: T) => void,
    onFail?: () => void,
  ) {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          onOk(result.data);
          return;
        }
        onFail?.();
        setError(`${label} failed: ${result.error.message}`);
      } catch (e) {
        onFail?.();
        setError(
          `${label} failed: ${e instanceof Error ? e.message : "unexpected error"}`,
        );
      }
    });
  }

  const paceSeconds = Number(pace);
  const paceIsInteger = Number.isInteger(paceSeconds);
  const isPaused = campaignStatus === "paused";
  const canPreview = !isPending && !isPaused && queuedCount > 0 && paceIsInteger;
  const canApply =
    preview !== null &&
    preview.paceSeconds === paceSeconds &&
    preview.affectedCount > 0 &&
    !isPaused &&
    !isPending;
  const canPause = !isPending && !isPaused && (queuedCount > 0 || pendingCount > 0);
  const canResume = !isPending && isPaused && paceIsInteger;

  function runPreview() {
    setError(null);
    setApplied(null);
    setPaused(null);
    setResumed(null);
    runAction(
      "Preview",
      () => previewCampaignCadenceChange(campaignId, paceSeconds),
      (data) => {
        setPreview(data);
      },
      () => setPreview(null),
    );
  }

  function runApply() {
    if (!preview || preview.paceSeconds !== paceSeconds) return;
    const confirmed = window.confirm(
      `Reschedule ${preview.affectedCount.toLocaleString()} unsent queued campaign texts to ${preview.paceSeconds}s cadence? This includes due, overdue, future, and unscheduled queued rows. Pending provider results and already sent, delivered, or failed texts will not be touched.`,
    );
    if (!confirmed) return;

    setError(null);
    setPaused(null);
    setResumed(null);
    runAction(
      "Apply cadence",
      () => applyCampaignCadenceChange(campaignId, paceSeconds, true),
      (data) => {
        setApplied(data);
        setPreview(data);
        router.refresh();
      },
    );
  }

  function runPause() {
    const confirmed = window.confirm(
      `Pause ${queuedCount.toLocaleString()} queued campaign texts? Pending provider results (${pendingCount.toLocaleString()}) may still finish, but queued texts will not be sent until resumed.`,
    );
    if (!confirmed) return;

    setError(null);
    setApplied(null);
    setPreview(null);
    setResumed(null);
    runAction(
      "Pause",
      () => pauseCampaignSends(campaignId, true),
      (data) => {
        setPaused(data);
        router.refresh();
      },
    );
  }

  function runResume() {
    const confirmed = window.confirm(
      `Resume ${pausedCount.toLocaleString()} paused campaign texts starting about 5 minutes from now at ${paceSeconds}s cadence?`,
    );
    if (!confirmed) return;

    setError(null);
    setApplied(null);
    setPreview(null);
    setPaused(null);
    runAction(
      "Resume",
      () => resumeCampaignSends(campaignId, paceSeconds, true),
      (data) => {
        setResumed(data);
        router.refresh();
      },
    );
  }

  return (
    <Card data-testid="campaign-cadence-control">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-base">
          <GaugeIcon className="h-4 w-4" />
          Send controls
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Seconds between sends
            <input
              type="number"
              inputMode="numeric"
              min={SMS_PACING_SECONDS.savedCampaignMin}
              max={SMS_PACING_SECONDS.max}
              step={1}
              value={pace}
              onChange={(event) => {
                setPace(event.target.value);
                setPreview(null);
                setApplied(null);
                setPaused(null);
                setResumed(null);
              }}
              className="h-10 w-36 rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={runPreview}
            disabled={!canPreview}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <SearchIcon className="h-4 w-4" />
            Preview cadence
          </button>
          <button
            type="button"
            onClick={runApply}
            disabled={!canApply}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CheckIcon className="h-4 w-4" />
            Apply cadence
          </button>
          <button
            type="button"
            onClick={runPause}
            disabled={!canPause}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PauseIcon className="h-4 w-4" />
            Pause sends
          </button>
          <button
            type="button"
            onClick={runResume}
            disabled={!canResume}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 text-sm font-semibold text-emerald-900 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlayIcon className="h-4 w-4" />
            Resume sends
          </button>
        </div>

        <div className="text-xs text-muted-foreground">
          Applies to unsent queued campaign texts. Pending provider results and
          already sent, delivered, or failed texts are left alone.
        </div>

        {preview ? <CadenceResult result={preview} label="Preview" /> : null}
        {applied ? <CadenceResult result={applied} label="Applied" /> : null}
        {resumed ? <CadenceResult result={resumed} label="Resumed" /> : null}
        {paused ? <PauseResult result={paused} /> : null}
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-semibold text-destructive"
          >
            {error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CadenceResult({
  result,
  label,
}: {
  result: CampaignCadenceChangeResult;
  label: "Preview" | "Applied" | "Resumed";
}) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="font-semibold">{label}:</span>{" "}
      {result.affectedCount.toLocaleString()} unsent queued messages at{" "}
      {result.paceSeconds}s cadence · first {formatCentral(result.firstScheduledFor)} ·
      last {formatCentral(result.lastScheduledFor)}
    </div>
  );
}

function PauseResult({ result }: { result: CampaignQueuePauseResult }) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="font-semibold">Paused:</span>{" "}
      {result.affectedCount.toLocaleString()} queued messages held ·{" "}
      {result.pausedCount.toLocaleString()} total paused ·{" "}
      {result.pendingCount.toLocaleString()} pending provider results still may
      finish
    </div>
  );
}

function formatCentral(iso: string | null): string {
  if (!iso) return "--";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "--";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(time));
}
