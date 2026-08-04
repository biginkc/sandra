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
      try {
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

          // Claim before showing the toast so later polling cycles do not
          // repeat the notification.
          notifiedRef.current.add(job.id);

          const verb = job.status === "partial" ? "finished with errors" : "failed";
          const title = job.title ?? `Job ${job.id.slice(0, 8)}`;

          toast.error(`${title} ${verb}`, {
            description: job.error_message ?? "Some rows did not import cleanly.",
            action: {
              label: "View job",
              onClick: () => {
                window.location.href = `/jobs/${job.id}`;
              },
            },
            duration: 10_000,
          });
        }
      } catch {
        // A failed poll must not stop the interval from trying again.
      }
    };

    let pollId: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (pollId === null) return;
      clearInterval(pollId);
      pollId = null;
    };

    const startPolling = () => {
      stopPolling();
      if (document.visibilityState !== "visible") return;

      void check();
      pollId = setInterval(() => {
        void check();
      }, POLL_INTERVAL_MS);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stopPolling();
      } else {
        startPolling();
      }
    };

    // The interval exists only while visible. Becoming visible performs the
    // immediate refresh before resuming the regular polling cadence.
    document.addEventListener("visibilitychange", handleVisibilityChange);
    startPolling();

    return () => {
      alive = false;
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return null;
}
