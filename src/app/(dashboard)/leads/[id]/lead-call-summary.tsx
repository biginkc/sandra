"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { ExternalLink, Phone } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { cn } from "@/lib/utils";

import { SandraRecordingPlayer } from "./sandra-recording-player";

type CallRecordingRow = Database["public"]["Tables"]["call_recordings"]["Row"];
type CallTranscriptRow = Database["public"]["Tables"]["call_transcripts"]["Row"];

export type CallActivityRollupRow = {
  id: string;
  started_at: string | null;
  outcome: string | null;
  disposition: string | null;
  recording_status: "none" | "pending" | "available" | "failed";
  transcript_status: "none" | "pending" | "available" | "failed";
  summary_status: "none" | "pending" | "available" | "failed";
  jitter_attempt_id: string;
  jitter_session_id: string | null;
  call_recordings: CallRecordingRow[];
  call_transcripts: CallTranscriptRow[];
};

type RealtimeCallActivityRow = Pick<
  CallActivityRollupRow,
  | "id"
  | "started_at"
  | "outcome"
  | "disposition"
  | "recording_status"
  | "transcript_status"
  | "summary_status"
  | "jitter_attempt_id"
  | "jitter_session_id"
>;

export type LeadCallSummaryProps = {
  propertyId: string;
  initialRows: CallActivityRollupRow[];
  jitterHost?: string;
};

const CALL_ACTIVITY_WITH_ARTIFACTS =
  "id, started_at, outcome, disposition, recording_status, transcript_status, summary_status, jitter_attempt_id, jitter_session_id, call_recordings(*), call_transcripts(*)";

const CHILD_STATUS_FIELDS = [
  "recording_status",
  "transcript_status",
  "summary_status",
] as const;

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

function newest<T extends { updated_at: string; created_at: string }>(rows: T[]): T | null {
  return (
    [...rows].sort((a, b) =>
      (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at),
    )[0] ?? null
  );
}

function mergeRealtimeRow(
  previous: CallActivityRollupRow | undefined,
  next: RealtimeCallActivityRow,
): CallActivityRollupRow {
  return {
    ...(previous ?? { call_recordings: [], call_transcripts: [] }),
    ...next,
  } as CallActivityRollupRow;
}

function statusChanged(
  previous: CallActivityRollupRow | undefined,
  next: RealtimeCallActivityRow,
): boolean {
  if (!previous) return true;
  return CHILD_STATUS_FIELDS.some((field) => previous[field] !== next[field]);
}

function CallArtifactStates({ row }: { row: CallActivityRollupRow }) {
  const recording = newest(row.call_recordings);
  const transcript = newest(row.call_transcripts);

  return (
    <div className="mt-3 space-y-3">
      <RecordingState row={row} recording={recording} />
      <SummaryState row={row} transcript={transcript} />
      <TranscriptState row={row} transcript={transcript} />
    </div>
  );
}

function RecordingState({
  row,
  recording,
}: {
  row: CallActivityRollupRow;
  recording: CallRecordingRow | null;
}) {
  if (row.recording_status === "available") {
    return (
      <div aria-label="Recording">
        <SandraRecordingPlayer
          callActivityId={row.id}
          durationSeconds={recording?.duration_seconds ?? undefined}
          key={row.id}
        />
      </div>
    );
  }
  if (row.recording_status === "pending") {
    return <p className="text-muted-foreground text-xs">Recording pending</p>;
  }
  if (row.recording_status === "failed") {
    return (
      <p className="text-destructive text-xs" role="status">
        Recording failed{recording?.error_message ? `: ${recording.error_message}` : ""}
      </p>
    );
  }
  return <p className="text-muted-foreground text-xs">No recording captured</p>;
}

function SummaryState({
  row,
  transcript,
}: {
  row: CallActivityRollupRow;
  transcript: CallTranscriptRow | null;
}) {
  if (row.summary_status === "available" && transcript?.summary) {
    return (
      <div aria-label="AI summary">
        <p className="text-muted-foreground text-xs font-medium">AI summary</p>
        <p className="mt-1 text-sm whitespace-pre-wrap">{transcript.summary}</p>
      </div>
    );
  }
  if (row.summary_status === "pending") {
    return <p className="text-muted-foreground text-xs">AI summary pending</p>;
  }
  if (row.summary_status === "failed") {
    return (
      <p className="text-destructive text-xs" role="status">
        AI summary failed
        {transcript?.summary_error_message ? `: ${transcript.summary_error_message}` : ""}
      </p>
    );
  }
  return null;
}

function TranscriptState({
  row,
  transcript,
}: {
  row: CallActivityRollupRow;
  transcript: CallTranscriptRow | null;
}) {
  if (row.transcript_status === "available" && transcript?.text) {
    return (
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Transcript</summary>
        <p className="text-muted-foreground mt-2 whitespace-pre-wrap">{transcript.text}</p>
      </details>
    );
  }
  if (row.transcript_status === "pending") {
    return <p className="text-muted-foreground text-xs">Transcript pending</p>;
  }
  if (row.transcript_status === "failed") {
    return (
      <p className="text-destructive text-xs" role="status">
        Transcript failed{transcript?.error_message ? `: ${transcript.error_message}` : ""}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-xs">
      {row.transcript_status === "available"
        ? "Transcript is still loading"
        : "No transcript available"}
    </p>
  );
}

export function LeadCallSummary({ propertyId, initialRows, jitterHost }: LeadCallSummaryProps) {
  const [rows, setRows] = useState<CallActivityRollupRow[]>(() => sortRows(initialRows));
  const rowsRef = useRef(rows);
  const refetchGenerationRef = useRef(new Map<string, number>());

  const hasJitterHost = typeof jitterHost === "string" && jitterHost.trim().length > 0;
  const deepLink = hasJitterHost
    ? `${jitterHost!.replace(/\/$/, "")}/history?prospect_id=${propertyId}`
    : null;
  const hostMissingTooltip = "Jitter host not configured";

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const upsert = (next: CallActivityRollupRow) => {
      if (!mounted) return;
      setRows((previousRows) => {
        const merged = sortRows([
          next,
          ...previousRows.filter((row) => row.id !== next.id),
        ]).slice(0, 20);
        rowsRef.current = merged;
        return merged;
      });
    };

    const handleChange = async (next: RealtimeCallActivityRow) => {
      const generation = (refetchGenerationRef.current.get(next.id) ?? 0) + 1;
      refetchGenerationRef.current.set(next.id, generation);
      const previous = rowsRef.current.find((row) => row.id === next.id);
      if (statusChanged(previous, next)) {
        const { data } = await supabase
          .from("call_activities")
          .select(CALL_ACTIVITY_WITH_ARTIFACTS)
          .eq("id", next.id)
          .eq("property_id", propertyId)
          .maybeSingle();
        if (refetchGenerationRef.current.get(next.id) !== generation) return;
        if (data) {
          upsert(data as unknown as CallActivityRollupRow);
          return;
        }
      }
      upsert(mergeRealtimeRow(previous, next));
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
          (payload) => void handleChange(payload.new as RealtimeCallActivityRow),
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "call_activities",
            filter: `property_id=eq.${propertyId}`,
          },
          (payload) => void handleChange(payload.new as RealtimeCallActivityRow),
        )
        .subscribe();
    };

    void start();
    return () => {
      mounted = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [propertyId]);

  const sortedRows = useMemo(() => sortRows(rows), [rows]);

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

  if (sortedRows.length === 0) {
    return (
      <section aria-label="Calls" className="border-border rounded-md border bg-background p-3">
        <div className="text-muted-foreground mb-3 text-xs font-semibold tracking-wide uppercase">
          Calls
        </div>
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center">
          <div className="bg-muted mb-3 rounded-full p-2">
            <Phone className="text-muted-foreground size-5" aria-hidden />
          </div>
          <p className="text-sm font-medium">No calls yet</p>
          <p className="text-muted-foreground mt-1 text-xs">This lead hasn&apos;t been called yet.</p>
          <div className="mt-4">{linkButton("Call this lead")}</div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Calls" className="border-border rounded-md border bg-background p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Calls</div>
          <div className="mt-1 text-2xl font-semibold">
            {sortedRows.length} {sortedRows.length === 1 ? "call" : "calls"}
          </div>
        </div>
        {linkButton("Open in Jitter")}
      </div>

      <div className="space-y-3" data-testid="call-history">
        {sortedRows.map((row) => {
          const badgeValue = row.disposition?.trim() || row.outcome;
          return (
            <article className="border-border/70 rounded-md border p-3" key={row.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={cn("border-transparent", outcomeClass(row.outcome))}>
                  {outcomeLabel(badgeValue)}
                </Badge>
                {row.started_at ? (
                  <time className="text-muted-foreground text-xs" dateTime={row.started_at}>
                    {formatDistanceToNow(new Date(row.started_at), { addSuffix: true })}
                  </time>
                ) : (
                  <span className="text-muted-foreground text-xs">Time unavailable</span>
                )}
              </div>
              <CallArtifactStates row={row} />
            </article>
          );
        })}
      </div>
    </section>
  );
}
