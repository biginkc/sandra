"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

type Job = Database["public"]["Tables"]["jobs"]["Row"];

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
      const terminal = new Set(["completed", "failed", "partial", "canceled"]);
      if (initial && !terminal.has(initial.status)) {
        pollId = setInterval(async () => {
          const latest = await fetchJob();
          if (latest && terminal.has(latest.status) && pollId) {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Importing</CardTitle>
        <CardDescription>
          You can close this tab and come back — the job runs on the server.
          Visit <code>/jobs</code> anytime to check in.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="text-destructive text-sm">{error}</div>
        )}
        <div className="flex items-center justify-between text-sm">
          <div>
            <Badge variant="outline">{job?.status ?? "…"}</Badge>
          </div>
          <div className="text-muted-foreground">
            {processed} of {total} rows
          </div>
        </div>
        <div className="bg-muted h-3 overflow-hidden rounded-full">
          <div
            className="bg-primary h-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="grid grid-cols-3 gap-3 text-center text-sm">
          <Stat label="Succeeded" value={job?.succeeded_items ?? 0} />
          <Stat label="Failed" value={job?.failed_items ?? 0} />
          <Stat
            label="Skipped"
            value={Math.max(0, processed - (job?.succeeded_items ?? 0) - (job?.failed_items ?? 0))}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border flex flex-col rounded-md border p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-lg font-semibold">{value}</span>
    </div>
  );
}
