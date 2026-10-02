"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import {
  connectedToastSince,
  connectedToastText,
  selectConnectedToasts,
  type ConnectedRequestRow,
} from "@/lib/norma/connected-toast";
import { NORMA_CONNECTED_OUTCOMES } from "@/lib/norma/tone";
import { createClient } from "@/lib/supabase/client";

const POLL_INTERVAL_MS = 5000;
const SEEN_KEY = "sandra.norma.connected-toasts";

function readSeen(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(-50) : [];
  } catch {
    return [];
  }
}

function writeSeen(ids: Iterable<string>) {
  try {
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    // Storage can be unavailable; the in-memory set still prevents repeats.
  }
}

/**
 * Mounted once in the dashboard layout, beside JobFailureNotifier, and uses the
 * same mechanism (a visible-tab poll; Realtime is documented there as
 * unreliable here). Toasts, in the upper right, when a Norma call REQUESTED BY
 * THE CURRENT USER completes with a connected outcome. Only that user sees it:
 * rows are filtered by requested_by = the signed-in user.
 */
export function NormaConnectedNotifier() {
  const router = useRouter();
  const notifiedRef = useRef<Set<string> | null>(null);
  const mountedAtRef = useRef<number | null>(null);

  useEffect(() => {
    // Set up here, not during render: both depend on the browser and the clock.
    const notified = (notifiedRef.current ??= new Set(readSeen()));
    const mountedAt = (mountedAtRef.current ??= Date.now());
    const supabase = createClient();
    let alive = true;
    let userId: string | null = null;

    const check = async () => {
      try {
        if (!userId) {
          const { data } = await supabase.auth.getUser();
          userId = data.user?.id ?? null;
        }
        if (!userId) return;
        const since = connectedToastSince(mountedAt);
        const { data, error } = await supabase
          .from("norma_call_requests")
          .select("id, property_id, status, outcome, completed_at, requested_by")
          .eq("requested_by", userId)
          .eq("status", "completed")
          .in("outcome", [...NORMA_CONNECTED_OUTCOMES])
          .gte("completed_at", since)
          .order("completed_at", { ascending: false })
          .limit(10);
        if (!alive || error || !data) return;

        const fresh = selectConnectedToasts(data as ConnectedRequestRow[], userId, notified, since);
        if (fresh.length === 0) return;
        // Claim before showing so a later poll cannot repeat the toast.
        for (const row of fresh) notified.add(row.id);
        writeSeen(notified);

        const propertyIds = [...new Set(fresh.map((row) => row.property_id))];
        const { data: properties } = await supabase
          .from("properties")
          .select("id, address, homeowner_contact_id")
          .in("id", propertyIds);
        const contactIds = [...new Set((properties ?? []).map((p) => p.homeowner_contact_id).filter((id): id is string => !!id))];
        const { data: contacts } = contactIds.length
          ? await supabase.from("contacts").select("id, first_name, last_name").in("id", contactIds)
          : { data: [] };

        for (const row of fresh) {
          const property = (properties ?? []).find((p) => p.id === row.property_id);
          const contact = (contacts ?? []).find((c) => c.id === property?.homeowner_contact_id);
          const name = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ");
          toast.success(connectedToastText(name, property?.address), {
            id: `norma-connected-${row.id}`,
            action: { label: "Open lead", onClick: () => router.push(`/leads/${row.property_id}`) },
            duration: 15_000,
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
      pollId = setInterval(() => void check(), POLL_INTERVAL_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopPolling();
      else startPolling();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    startPolling();
    return () => {
      alive = false;
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [router]);

  return null;
}
