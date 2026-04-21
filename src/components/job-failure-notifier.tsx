"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

type Job = Pick<
  Database["public"]["Tables"]["jobs"]["Row"],
  "id" | "status" | "title" | "type" | "error_message" | "created_at"
>;

const POLL_INTERVAL_MS = 5000;
const TERMINAL_BAD_STATUSES = new Set<Job["status"]>(["failed", "partial"]);

/**
 * Mounted once in the dashboard layout.
 *
 * Polls the jobs table every 5 seconds for rows that have transitioned into a
 * terminal bad state since the component mounted, and shows a toast with a
 * link to /jobs. Uses an in-memory set keyed on job id to prevent duplicate
 * toasts for the same job across polling cycles.
 *
 * We intentionally do NOT rely on Realtime here — postgres_changes delivery
 * has been unreliable in this setup; polling is cheap (one query every 5s)
 * and guarantees visibility. When Realtime is fixed, this can layer on top.
 */
export function JobFailureNotifier() {
  const notifiedRef = useRef<Set<string>>(new Set());
  const mountedAtRef = useRef<string>(new Date().toISOString());

  useEffect(() => {
    const supabase = createClient();
    let alive = true;

    const check = async () => {
      const { data, error } = await supabase
        .from("jobs")
        .select("id, status, title, type, error_message, created_at")
        .in("status", ["failed", "partial"])
        .gte("created_at", mountedAtRef.current)
        .order("created_at", { ascending: false })
        .limit(20);

      if (!alive || error || !data) return;

      for (const job of data) {
        if (notifiedRef.current.has(job.id)) continue;
        if (!TERMINAL_BAD_STATUSES.has(job.status)) continue;

        const verb = job.status === "partial" ? "finished with errors" : "failed";
        const title = job.title ?? `Job ${job.id.slice(0, 8)}`;

        toast.error(`${title} ${verb}`, {
          description: job.error_message ?? "Some rows did not import cleanly.",
          action: {
            label: "View job",
            onClick: () => {
              window.location.href = "/jobs";
            },
          },
          duration: 10_000,
        });

        notifiedRef.current.add(job.id);
      }
    };

    // Initial check + interval
    check();
    const id = setInterval(check, POLL_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return null;
}
