"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { retryCsvImportJob, retryImportListAssignment } from "../actions";

type Job = Database["public"]["Tables"]["jobs"]["Row"];

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "partial",
  "partially_completed",
  "canceled",
]);

/**
 * Final step of the import wizard. While the job is running it shows
 * a live progress bar and explicit "you can close this tab" copy
 * (the work is queued server-side; closing the browser doesn't lose
 * progress). When the job reaches a terminal status the same card
 * swaps in-place to a summary + action buttons (View properties /
 * Job details / New import).
 *
 * Used to be a two-step (progress → done) flow, but that footer-Next
 * button contradicted the "you can close this tab" copy. Combining
 * the two states into one card removes the ambiguity. See
 * `docs/feedback/feedback a.pdf` (item 1).
 */
export function StepProgress({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const fetchJob = async (): Promise<Job | null> => {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("id", jobId)
        .single();
      if (!mounted) return null;
      if (error) {
        setError(error.message);
        return null;
      }
      setJob(data);
      return data;
    };

    const start = async () => {
      // Must await setAuth() BEFORE subscribing — otherwise the socket
      // opens as anon and RLS on `jobs` silently filters every event.
      // Earlier attempts subscribed in parallel with setAuth and never
      // received a single UPDATE.
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);

      if (!mounted) return;

      channel = supabase
        .channel(`jobs:${jobId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "jobs",
            filter: `id=eq.${jobId}`,
          },
          (payload) => {
            setJob(payload.new as Job);
          },
        )
        .subscribe();

      const initial = await fetchJob();

      // Low-frequency safety net — Realtime is the primary channel; this
      // only catches rare socket drops. Stops as soon as the job is terminal.
      if (initial && !TERMINAL_STATUSES.has(initial.status)) {
        pollId = setInterval(async () => {
          const latest = await fetchJob();
          if (latest && TERMINAL_STATUSES.has(latest.status) && pollId) {
            clearInterval(pollId);
            pollId = null;
          }
        }, 15000);
      }
    };

    start();

    return () => {
      mounted = false;
      if (pollId) clearInterval(pollId);
      if (channel) supabase.removeChannel(channel);
    };
  }, [jobId]);

  const total = job?.total_items ?? 0;
  const processed = job?.processed_items ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  const isTerminal = job ? TERMINAL_STATUSES.has(job.status) : false;
  const skippedCount = Math.max(
    0,
    (isTerminal ? total : processed) -
      (job?.succeeded_items ?? 0) -
      (job?.failed_items ?? 0),
  );

  const { title, description } = describeState(job, isTerminal);

  // Hard-rule counter from finalize: phones dropped because they had no
  // line type. result_summary is untyped Json — read defensively.
  const summary = (job?.result_summary ?? null) as {
    droppedUnlabeledPhones?: number;
    dncRows?: number;
    sideEffects?: Record<string, { status?: string; message?: string }>;
  } | null;
  const droppedUnlabeledPhones = summary?.droppedUnlabeledPhones ?? 0;
  const dncRows = summary?.dncRows ?? 0;
  const listAssignment = summary?.sideEffects?.listAssignment;
  const incompleteSideEffects = Object.entries(summary?.sideEffects ?? {})
    .filter(([key, effect]) => key !== "listAssignment" && ["failed", "pending"].includes(effect.status ?? ""));

  const retry = async (kind: "rows" | "list") => {
    setRetrying(true);
    const result = kind === "rows"
      ? await retryCsvImportJob(jobId)
      : await retryImportListAssignment(jobId);
    setRetrying(false);
    if (result.ok) toast.success(kind === "rows" ? "Import resumed." : "List assignment completed.");
    else toast.error(result.error.message);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <div className="text-destructive text-sm">{error}</div>}
        <div className="flex items-center justify-between text-sm">
          <div>
            <Badge variant="outline">{job?.status ?? "…"}</Badge>
          </div>
          <div className="text-muted-foreground">
            {processed} of {total} rows
          </div>
        </div>
        {!isTerminal && (
          <div className="bg-muted h-3 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        <div className="grid grid-cols-3 gap-3 text-center text-sm">
          <Stat label="Succeeded" value={job?.succeeded_items ?? 0} />
          <Stat label="Failed" value={job?.failed_items ?? 0} />
          <Stat label="Skipped" value={skippedCount} />
        </div>
        {isTerminal && droppedUnlabeledPhones > 0 && (
          <div className="text-muted-foreground text-sm">
            {droppedUnlabeledPhones.toLocaleString()} phone{" "}
            {droppedUnlabeledPhones === 1 ? "number" : "numbers"} skipped — no
            line type. Unlabeled numbers are never saved.
          </div>
        )}
        {isTerminal && (
          <div className="bg-foreground text-background rounded-md p-3 text-sm">
            ⊘ {dncRows.toLocaleString()} Do-Not-Contact {dncRows === 1 ? "record" : "records"} imported locked and excluded from optional services.
          </div>
        )}
        {isTerminal && listAssignment?.status === "failed" && (
          <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
            <strong>List assignment did not complete.</strong>{" "}
            {listAssignment.message ?? "The imported rows are kept."}
            <Button size="sm" variant="outline" className="ml-3" disabled={retrying} onClick={() => void retry("list")}>Retry list assignment</Button>
          </div>
        )}
        {isTerminal && incompleteSideEffects.map(([key, effect]) => (
          <div key={key} className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
            <strong>{sideEffectLabel(key)} did not complete.</strong>{" "}
            {effect.message ?? "Open Job details for the recorded failure and next step."}
          </div>
        ))}
      </CardContent>
      {isTerminal && (
        <CardFooter className="flex flex-wrap gap-2">
          <Link href="/properties?imported=today" className={buttonVariants()}>
            Review imported Prospects
          </Link>
          {(job?.failed_items ?? 0) > 0 && (
            <Button variant="outline" disabled={retrying} onClick={() => void retry("rows")}>
              Retry failed rows
            </Button>
          )}
          {(job?.failed_items ?? 0) > 0 && (
            <Link href={`/jobs/${jobId}`} className={buttonVariants({ variant: "outline" })}>
              Download failed rows
            </Link>
          )}
          <Link
            href={`/jobs/${jobId}`}
            className={buttonVariants({ variant: "outline" })}
          >
            Job details
          </Link>
          <Link
            href="/import"
            className={buttonVariants({ variant: "ghost" })}
          >
            New import
          </Link>
        </CardFooter>
      )}
    </Card>
  );
}

function sideEffectLabel(key: string): string {
  return ({
    cass: "Address verification",
    lineTypeClassification: "Line-type classification",
    consent: "Consent recording",
    sequenceEnrollment: "Sequence enrollment",
    skipTrace: "Skip trace",
  } as Record<string, string>)[key] ?? key;
}

function describeState(
  job: Job | null,
  isTerminal: boolean,
): { title: string; description: string } {
  if (!job || !isTerminal) {
    return {
      title: job?.status === "queued" ? "Queued" : "Processing",
      description:
        "This runs in the background. You can leave this page — the job keeps going and this screen picks up where it left off when you return.",
    };
  }
  if (job.status === "completed") {
    return { title: "Completed", description: "Every row and every follow-up action reached a terminal state. Nothing is still pending." };
  }
  if (job.status === "partial" || job.status === "partially_completed") {
    return {
      title: "Partially completed",
      description:
        "Most rows imported. Some work failed and is reported truthfully below — this job will not be called Completed.",
    };
  }
  if (job.status === "failed") {
    return {
      title: "Failed",
      description:
        "The job stopped before completing. Rows already imported are kept and listed; nothing was double-imported. Retry resumes from the failure point.",
    };
  }
  if (job.status === "canceled") {
    return { title: "Import canceled", description: "The job was canceled." };
  }
  return { title: "Import complete", description: "Done." };
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border flex flex-col rounded-md border p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-lg font-semibold">{value}</span>
    </div>
  );
}
