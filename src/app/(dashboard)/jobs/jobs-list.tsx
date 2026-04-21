"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

type Job = Database["public"]["Tables"]["jobs"]["Row"];

export function JobsList() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);

      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!mounted) return;
      if (error) setError(error.message);
      else setJobs(data ?? []);
      setLoading(false);
    })();

    const channel = supabase
      .channel("jobs:list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setJobs((prev) => [payload.new as Job, ...prev].slice(0, 50));
          } else if (payload.eventType === "UPDATE") {
            setJobs((prev) =>
              prev.map((j) =>
                j.id === (payload.new as Job).id ? (payload.new as Job) : j,
              ),
            );
          } else if (payload.eventType === "DELETE") {
            setJobs((prev) =>
              prev.filter((j) => j.id !== (payload.old as Job).id),
            );
          }
        },
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  if (loading) {
    return (
      <div className="text-muted-foreground text-sm">Loading jobs…</div>
    );
  }

  if (error) {
    return <div className="text-destructive text-sm">Error: {error}</div>;
  }

  return (
    <div className="border-border rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="text-muted-foreground py-8 text-center"
              >
                No jobs yet.
              </TableCell>
            </TableRow>
          ) : (
            jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell className="font-medium">
                  {job.title ?? job.id.slice(0, 8)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{job.type}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(job.status)}>
                    {job.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {job.processed_items}/{job.total_items}
                  {job.failed_items > 0 && (
                    <span className="text-destructive">
                      {" "}
                      · {job.failed_items} failed
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDistanceToNow(new Date(job.created_at), {
                    addSuffix: true,
                  })}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "partial") return "secondary";
  if (status === "canceled") return "outline";
  return "secondary";
}
