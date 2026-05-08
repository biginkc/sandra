"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { ExternalLink, FileAudio, FileText, Phone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export type CallActivityRollupRow = {
  id: string;
  started_at: string | null;
  outcome: string | null;
  disposition: string | null;
  recording_status: "none" | "pending" | "available" | "failed";
  transcript_status: "none" | "pending" | "available" | "failed";
};

export type LeadCallSummaryProps = {
  propertyId: string;
  initialRows: CallActivityRollupRow[];
  jitterHost?: string;
};

function sortRows(rows: CallActivityRollupRow[]): CallActivityRollupRow[] {
  return [...rows].sort((a, b) => {
    const aTime = a.started_at ?? "";
    const bTime = b.started_at ?? "";
    return bTime.localeCompare(aTime);
  });
}

function outcomeLabel(outcome: string | null): string {
  if (!outcome) return "Unknown";
  const labels: Record<string, string> = {
    busy: "Busy",
    canceled: "Canceled",
    connected_human: "Connected",
    failed: "Failed",
    no_answer: "No answer",
    unknown: "Unknown",
    voicemail: "Voicemail",
  };
  return labels[outcome] ?? outcome.replaceAll("_", " ");
}

function outcomeClass(outcome: string | null): string {
  if (outcome === "connected_human") return "bg-emerald-100 text-emerald-900";
  if (outcome === "voicemail") return "bg-amber-100 text-amber-900";
  if (outcome === "failed" || outcome === "canceled") {
    return "bg-destructive/10 text-destructive";
  }
  return "bg-muted text-muted-foreground";
}

function countStatus(
  rows: CallActivityRollupRow[],
  field: "recording_status" | "transcript_status",
  status: "available" | "pending",
): number {
  return rows.filter((row) => row[field] === status).length;
}

export function LeadCallSummary({
  propertyId,
  initialRows,
  jitterHost,
}: LeadCallSummaryProps) {
  const [rows, setRows] = useState<CallActivityRollupRow[]>(() =>
    sortRows(initialRows),
  );

  const hasJitterHost =
    typeof jitterHost === "string" && jitterHost.trim().length > 0;
  const deepLink = hasJitterHost
    ? `${jitterHost!.replace(/\/$/, "")}/history?prospect_id=${propertyId}`
    : null;
  const hostMissingTooltip = "Jitter host not configured";

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const upsert = (next: CallActivityRollupRow) => {
      setRows((prev) => {
        const merged = [next, ...prev.filter((row) => row.id !== next.id)];
        return sortRows(merged).slice(0, 20);
      });
    };

    const start = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted) return;

      channel = supabase
        .channel(`call_activities:${propertyId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "call_activities",
            filter: `property_id=eq.${propertyId}`,
          },
          (payload) => upsert(payload.new as CallActivityRollupRow),
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "call_activities",
            filter: `property_id=eq.${propertyId}`,
          },
          (payload) => upsert(payload.new as CallActivityRollupRow),
        )
        .subscribe();
    };

    start();
    return () => {
      mounted = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [propertyId]);

  const rollup = useMemo(() => {
    const latest = rows[0] ?? null;
    return {
      count: rows.length,
      latest,
      recordingAvailable: countStatus(rows, "recording_status", "available"),
      recordingPending: countStatus(rows, "recording_status", "pending"),
      transcriptAvailable: countStatus(rows, "transcript_status", "available"),
      transcriptPending: countStatus(rows, "transcript_status", "pending"),
    };
  }, [rows]);

  const linkButton = (label: "Open in Jitter" | "Call this lead") =>
    deepLink ? (
      <a href={deepLink} aria-label={`${label} in Jitter`}>
        <Button size="sm" variant={label === "Open in Jitter" ? "outline" : "default"}>
          {label}
          <ExternalLink className="ml-1 size-3.5" aria-hidden />
        </Button>
      </a>
    ) : (
      <Button
        type="button"
        size="sm"
        variant={label === "Open in Jitter" ? "outline" : "default"}
        disabled
        aria-disabled="true"
        title={hostMissingTooltip}
      >
        {label}
        <ExternalLink className="ml-1 size-3.5" aria-hidden />
      </Button>
    );

  if (rollup.count === 0) {
    return (
      <section
        aria-label="Calls"
        className="border-border rounded-md border bg-background p-3"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            Calls
          </div>
        </div>
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center">
          <div className="bg-muted mb-3 rounded-full p-2">
            <Phone className="text-muted-foreground size-5" aria-hidden />
          </div>
          <p className="text-sm font-medium">No calls yet</p>
          <p className="text-muted-foreground mt-1 text-xs">
            This lead hasn&apos;t been called yet.
          </p>
          <div className="mt-4">{linkButton("Call this lead")}</div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Calls"
      className="border-border rounded-md border bg-background p-3"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            Calls
          </div>
          <div className="mt-1 text-2xl font-semibold">
            {rollup.count} {rollup.count === 1 ? "call" : "calls"}
          </div>
        </div>
        {linkButton("Open in Jitter")}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge
          data-testid="latest-outcome-badge"
          className={cn("border-transparent", outcomeClass(rollup.latest?.outcome ?? null))}
        >
          {outcomeLabel(rollup.latest?.outcome ?? null)}
        </Badge>
        {rollup.latest?.started_at ? (
          <span
            data-testid="latest-call-timestamp"
            className="text-muted-foreground text-xs"
          >
            {formatDistanceToNow(new Date(rollup.latest.started_at), {
              addSuffix: true,
            })}
          </span>
        ) : null}
      </div>

      <div
        aria-label="Recording and transcript availability"
        className="mt-4 grid grid-cols-2 gap-2 text-xs"
      >
        <div className="border-border/70 rounded-md border p-2">
          <div className="text-muted-foreground flex items-center gap-1">
            <FileAudio className="size-3.5" aria-hidden />
            Recording
          </div>
          <div className="mt-1 font-medium">
            {rollup.recordingAvailable} available
            {rollup.recordingPending > 0 ? (
              <span className="text-muted-foreground">
                {" "}
                · {rollup.recordingPending} pending
              </span>
            ) : null}
          </div>
        </div>
        <div className="border-border/70 rounded-md border p-2">
          <div className="text-muted-foreground flex items-center gap-1">
            <FileText className="size-3.5" aria-hidden />
            Transcript
          </div>
          <div className="mt-1 font-medium">
            {rollup.transcriptAvailable} available
            {rollup.transcriptPending > 0 ? (
              <span className="text-muted-foreground">
                {" "}
                · {rollup.transcriptPending} pending
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
