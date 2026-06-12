"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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

type Job = Database["public"]["Tables"]["jobs"]["Row"];

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "partial",
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
  } | null;
  const droppedUnlabeledPhones = summary?.droppedUnlabeledPhones ?? 0;

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
      </CardContent>
      {isTerminal && (
        <CardFooter className="flex flex-wrap gap-2">
          <Link href="/properties" className={buttonVariants()}>
            View properties
          </Link>
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

function describeState(
  job: Job | null,
  isTerminal: boolean,
): { title: string; description: string } {
  if (!job || !isTerminal) {
    return {
      title: "Importing",
      description:
        "You can close this tab and come back — the job runs on the server. Visit /jobs anytime to check in.",
    };
  }
  if (job.status === "completed") {
    return { title: "Import complete", description: "All rows processed." };
  }
  if (job.status === "partial") {
    return {
      title: "Import finished with errors",
      description:
        "Some rows failed. Open Job details to see specifics for the failed rows.",
    };
  }
  if (job.status === "failed") {
    return {
      title: "Import failed",
      description:
        "The job failed before completing. Open Job details to see why.",
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
