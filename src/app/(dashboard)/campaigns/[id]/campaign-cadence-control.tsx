"use client";

import { CheckIcon, GaugeIcon, SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SMS_PACING_SECONDS } from "@/lib/messaging/pacing";

import {
  applyCampaignCadenceChange,
  previewCampaignCadenceChange,
  type CampaignCadenceChangeResult,
} from "../actions";

type Props = {
  campaignId: string;
  currentPaceSeconds: number | null;
};

export function CampaignCadenceControl({
  campaignId,
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
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const paceSeconds = Number(pace);
  const canApply =
    preview !== null &&
    preview.paceSeconds === paceSeconds &&
    preview.affectedCount > 0 &&
    !isPending;

  function runPreview() {
    setError(null);
    setApplied(null);
    startTransition(async () => {
      const result = await previewCampaignCadenceChange(campaignId, paceSeconds);
      if (result.ok) {
        setPreview(result.data);
      } else {
        setPreview(null);
        setError(result.error.message);
      }
    });
  }

  function runApply() {
    if (!preview || preview.paceSeconds !== paceSeconds) return;
    const confirmed = window.confirm(
      `Reschedule ${preview.affectedCount.toLocaleString()} future queued SMS rows to ${preview.paceSeconds}s cadence? This will not touch pending, sent, delivered, or failed messages.`,
    );
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await applyCampaignCadenceChange(
        campaignId,
        paceSeconds,
        true,
      );
      if (result.ok) {
        setApplied(result.data);
        setPreview(result.data);
        router.refresh();
      } else {
        setError(result.error.message);
      }
    });
  }

  return (
    <Card data-testid="campaign-cadence-control">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-base">
          <GaugeIcon className="h-4 w-4" />
          Cadence
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
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
              }}
              className="h-10 w-36 rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={runPreview}
            disabled={isPending}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <SearchIcon className="h-4 w-4" />
            Preview
          </button>
          <button
            type="button"
            onClick={runApply}
            disabled={!canApply}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CheckIcon className="h-4 w-4" />
            Apply reschedule
          </button>
        </div>

        {preview ? <CadenceResult result={preview} label="Preview" /> : null}
        {applied ? <CadenceResult result={applied} label="Applied" /> : null}
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
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
  label: "Preview" | "Applied";
}) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="font-semibold">{label}:</span>{" "}
      {result.affectedCount.toLocaleString()} future queued messages at{" "}
      {result.paceSeconds}s cadence · first {formatCentral(result.firstScheduledFor)} ·
      last {formatCentral(result.lastScheduledFor)}
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
