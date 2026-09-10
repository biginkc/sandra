"use client";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { normalizePhone } from "@/lib/csv/normalize";
import type { InboxDetail } from "./inbox-detail-data";

export function detailSafetySubscriptions(detail: InboxDetail, currentUserId: string | null) {
  const filters = [
    { table: "contacts", filter: `id=eq.${detail.contactId}` },
    { table: "consent_events", filter: `contact_id=eq.${detail.contactId}` },
    { table: "message_threads", filter: `conversation_id=eq.${detail.conversationId}` },
    { table: "ai_disposition_reviews", filter: `conversation_id=eq.${detail.conversationId}` },
  ];
  if (detail.propertyId) filters.push({ table: "properties", filter: `id=eq.${detail.propertyId}` });
  const phone = normalizePhone(detail.threadCustomerPhone ?? "");
  if (phone) filters.push({ table: "sms_phone_suppressions", filter: `phone_e164=eq.${phone}` });
  if (currentUserId) filters.push({ table: "memberships", filter: `user_id=eq.${currentUserId}` });
  return filters;
}

/** Events request an authoritative read; payload values never authorize reply.
 * Poll/focus/reconnect repair missed events, deletion gaps and time-based expiry. */
export function useDetailReconciliation(detail: InboxDetail | null, currentUserId: string | null, refresh: () => Promise<void>) {
  const filtersKey = JSON.stringify(detail ? detailSafetySubscriptions(detail, currentUserId) : []);
  useEffect(() => {
    const filters = JSON.parse(filtersKey) as Array<{ table: string; filter: string }>;
    if (!filters.length) return;
    const client = createClient();
    let cancelled = false;
    let connected = false;
    const reconcile = () => {
      if (!cancelled && document.visibilityState === "visible") void refresh();
    };
    const channel = client.channel("cockpit:selected-safety");
    for (const filter of filters) {
      channel.on("postgres_changes", { event: "*", schema: "public", ...filter }, reconcile);
    }
    void client.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session?.access_token) client.realtime.setAuth(data.session.access_token);
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          // Initial detail already came from the server. Repair subsequent
          // reconnects without duplicating the initial selected-detail read.
          if (connected) reconcile();
          connected = true;
        }
      });
    }).catch(reconcile);
    const interval = window.setInterval(reconcile, 30_000);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
      void client.removeChannel(channel);
    };
  }, [filtersKey, refresh]);
}
