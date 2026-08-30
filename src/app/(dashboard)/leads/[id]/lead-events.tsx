"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { ActivityIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { OPERATOR_TIME_ZONE } from "@/lib/messages/message-metrics";
import { createClient } from "@/lib/supabase/client";
import type { Database, Json } from "@/lib/supabase/types";

type LeadEventRow = Database["public"]["Tables"]["lead_events"]["Row"];
export type LeadEvent = Pick<
  LeadEventRow,
  | "id"
  | "property_id"
  | "actor_type"
  | "actor_id"
  | "event_type"
  | "payload"
  | "created_at"
>;

const EVENT_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: OPERATOR_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const ESIGN_TEMPLATE_TITLE_MAX_LENGTH = 160;

export function useLeadEvents({
  propertyId,
  initial,
  serverSnapshot = initial,
}: {
  propertyId: string;
  initial: LeadEvent[];
  serverSnapshot?: LeadEvent[];
}): { events: LeadEvent[]; reconciled: boolean } {
  const [events, setEvents] = useState<LeadEvent[]>(() =>
    sortLeadEvents(initial),
  );
  const [reconciledPropertyId, setReconciledPropertyId] = useState<
    string | null
  >(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Server refreshes merge into the append-only live snapshot; the property filter drops route-stale rows.
    setEvents((previous) =>
      mergeLeadEvents(
        previous.filter((event) => event.property_id === propertyId),
        initial.filter((event) => event.property_id === propertyId),
      ),
    );
  }, [initial, propertyId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Each server refresh requires its own successful catch-up before clearing a server-read error.
    setReconciledPropertyId(null);
  }, [propertyId, serverSnapshot]);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const start = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted) return;

      const reconcile = async () => {
        const result = await supabase
          .from("lead_events")
          .select(
            "id, property_id, actor_type, actor_id, event_type, payload, created_at",
          )
          .eq("property_id", propertyId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(200);
        if (!mounted || result.error) return;
        setEvents((previous) =>
          mergeLeadEvents(previous, (result.data ?? []) as LeadEvent[]),
        );
        setReconciledPropertyId(propertyId);
      };

      channel = supabase
        // A unique topic avoids reusing a singleton client's channel while the
        // previous same-property subscription is still leaving after refresh.
        .channel(`lead_events:${propertyId}:${crypto.randomUUID()}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "lead_events",
            filter: `property_id=eq.${propertyId}`,
          },
          (payload) => {
            const row = payload.new as LeadEvent;
            if (!mounted || row.property_id !== propertyId) return;
            setEvents((previous) => mergeLeadEvents(previous, [row]));
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void reconcile();
        });
    };
    void start();

    return () => {
      mounted = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [propertyId, serverSnapshot]);

  return {
    events,
    reconciled: reconciledPropertyId === propertyId,
  };
}

export function LeadEventPill({
  event,
  authorEmails,
  currentUserId,
}: {
  event: LeadEvent;
  authorEmails: Record<string, string>;
  currentUserId: string | null;
}) {
  return (
    <div
      className="border-border/80 bg-muted/80 text-muted-foreground inline-flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-full border px-3 py-1.5 text-center text-[11px] shadow-sm"
      data-testid="lead-event-row"
      data-event-type={event.event_type}
    >
      <ActivityIcon className="size-3 shrink-0" aria-hidden />
      <span className="text-foreground font-medium">
        {formatLeadEventSentence(event, authorEmails, currentUserId)}
      </span>
      <span aria-hidden>·</span>
      <time
        dateTime={event.created_at}
        title={EVENT_TIME_FORMATTER.format(new Date(event.created_at))}
      >
        {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
      </time>
    </div>
  );
}

export function formatLeadEventSentence(
  event: LeadEvent,
  authorEmails: Record<string, string>,
  currentUserId: string | null,
): string {
  const payload = readPayload(event.payload);
  const actor = actorLabel(event, authorEmails, currentUserId);
  const from = readDisplayValue(payload, "from");
  const to = readDisplayValue(payload, "to");
  const label = readString(payload, "label");
  const batchSuffix = formatBatchSuffix(payload);

  switch (event.event_type) {
    case "lead_created":
      return `${actor} created the lead`;
    case "qualified":
      return `${actor} qualified the lead`;
    case "reverted_to_prospect":
      return `${actor} moved the lead back to prospect`;
    case "status_changed":
      return hasTransitionPayload(payload)
        ? `${actor} changed status: ${from} → ${to}`
        : `${actor} recorded activity`;
    case "motivation_changed":
      return hasTransitionPayload(payload)
        ? `${actor} changed motivation: ${from} → ${to}`
        : `${actor} recorded activity`;
    case "assigned":
      return hasAssigneeTransition(payload)
        ? `${actor} changed assignee: ${assigneeLabel(payload.from, authorEmails, currentUserId)} → ${assigneeLabel(payload.to, authorEmails, currentUserId)}${batchSuffix}`
        : `${actor} recorded activity`;
    case "task_created": {
      const taskType = readString(payload, "task_type");
      const dueAt = readString(payload, "due_at");
      return `${actor} created ${taskType ? withArticle(humanize(taskType)) : "a task"}${dueAt ? ` for ${formatEventTime(dueAt)}` : ""}`;
    }
    case "task_completed":
      return `${actor} completed a task`;
    case "task_snoozed":
      return `${actor} snoozed a task${readString(payload, "to") ? ` until ${formatEventTime(String(payload.to))}` : ""}`;
    case "task_reassigned":
      return isNonEmptyString(payload.to)
        ? `${actor} reassigned a task to ${assigneeLabel(payload.to, authorEmails, currentUserId)}`
        : `${actor} recorded activity`;
    case "appointment_booked":
      return `${actor} booked an appointment${readString(payload, "due_at") ? ` for ${formatEventTime(String(payload.due_at))}` : ""}`;
    case "appointment_held":
      return `${actor} marked the appointment held`;
    case "appointment_no_show":
      return `${actor} marked the appointment no-show`;
    case "appointment_canceled":
      return `${actor} canceled the appointment`;
    case "appointment_rescheduled":
      return `${actor} rescheduled the appointment${readString(payload, "to") ? ` for ${formatEventTime(String(payload.to))}` : ""}`;
    case "appointment_reassigned":
      return isNonEmptyString(payload.to)
        ? `${actor} reassigned the appointment to ${assigneeLabel(payload.to, authorEmails, currentUserId)}`
        : `${actor} recorded activity`;
    case "tag_applied":
      return `${actor} added tag ${label ?? "(unnamed)"}${batchSuffix}`;
    case "tag_removed":
      return `${actor} removed tag ${label ?? "(unnamed)"}${batchSuffix}`;
    case "list_added":
      return `${actor} added the lead to ${label ?? "a list"}${batchSuffix}`;
    case "list_removed":
      return `${actor} removed the lead from ${label ?? "a list"}${batchSuffix}`;
    case "sequence_enrolled":
      return `${actor} enrolled the lead in ${label ?? "a sequence"}${batchSuffix}`;
    case "sequence_paused": {
      const sequenceCount = formatCountedSequence(payload);
      return sequenceCount
        ? `${actor} paused ${sequenceCount}${batchSuffix}`
        : `${actor} recorded activity`;
    }
    case "sequence_resumed": {
      const sequenceCount = formatCountedSequence(payload);
      return sequenceCount
        ? `${actor} resumed ${sequenceCount}`
        : isSingleSequencePayload(payload)
          ? `${actor} resumed a sequence`
          : `${actor} recorded activity`;
    }
    case "sequence_canceled":
      return `${actor} canceled a sequence enrollment`;
    case "dispo_set":
      return hasTransitionPayload(payload)
        ? `${actor} changed disposition: ${from} → ${to}`
        : `${actor} recorded activity`;
    case "ai_escalated": {
      const reason = readString(payload, "reason");
      return `${actor} requested human review${reason ? ` — ${humanize(reason)}` : ""}`;
    }
    case "ai_escalation_cleared":
      return `${actor} cleared human review`;
    case "ai_responder_toggled":
      return typeof payload.to === "boolean"
        ? `${actor} turned Sandra replies ${payload.to ? "off" : "on"}`
        : `${actor} recorded activity`;
    case "skip_trace_toggled":
      return typeof payload.to === "boolean"
        ? `${actor} turned skip tracing ${payload.to ? "off" : "on"}`
        : `${actor} recorded activity`;
    case "skip_trace_requested":
      return `${actor} requested skip tracing${batchSuffix}`;
    case "skip_trace_completed": {
      const outcome = readString(payload, "outcome");
      return `${actor} completed skip tracing${outcome ? ` — ${humanize(outcome)}` : ""}`;
    }
    case "address_verified":
      return `${actor} verified the address`;
    case "consent_captured":
      return `${actor} captured ${readString(payload, "channel")?.toUpperCase() ?? "contact"} consent`;
    case "opted_out":
      return `${actor} recorded an ${readString(payload, "channel")?.toUpperCase() ?? "contact"} opt-out`;
    case "queued_message_deleted":
      return `${actor} deleted a queued message`;
    case "esign_awaiting":
      return formatEsignEventSentence(
        event,
        payload,
        (title) => `System sent ${title} for signature`,
      );
    case "esign_viewed":
      return formatEsignEventSentence(
        event,
        payload,
        (title) => `System recorded ${title} as viewed`,
      );
    case "esign_signed":
      return formatEsignEventSentence(
        event,
        payload,
        (title) => `System recorded ${title} as signed`,
      );
    case "esign_declined":
      return formatEsignEventSentence(
        event,
        payload,
        (title) => `System recorded ${title} as declined`,
      );
    case "esign_voided":
      return formatEsignEventSentence(
        event,
        payload,
        (title) => `System recorded ${title} as voided`,
      );
    case "esign_signed_pdf_ready":
      return formatEsignEventSentence(
        event,
        payload,
        (title) => `System saved the signed PDF for ${title}`,
      );
    default:
      return `${actor} recorded activity`;
  }
}

function formatEsignEventSentence(
  event: LeadEvent,
  payload: Record<string, Json | undefined>,
  format: (templateTitle: string) => string,
): string {
  const templateTitle = readEsignTemplateTitle(payload);
  return event.actor_type === "system" &&
    event.actor_id === null &&
    templateTitle !== null
    ? format(templateTitle)
    : "System recorded activity";
}

function readEsignTemplateTitle(
  payload: Record<string, Json | undefined>,
): string | null {
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "template_title") return null;
  const value = payload.template_title;
  if (typeof value !== "string") return null;
  const title = value.trim();
  return title.length >= 1 && title.length <= ESIGN_TEMPLATE_TITLE_MAX_LENGTH
    ? title
    : null;
}

function sortLeadEvents(events: LeadEvent[]): LeadEvent[] {
  return [...events].sort(
    (a, b) =>
      compareActivityTimestamps(a.created_at, b.created_at) ||
      a.id.localeCompare(b.id),
  );
}

function mergeLeadEvents(...snapshots: LeadEvent[][]): LeadEvent[] {
  const byId = new Map<string, LeadEvent>();
  for (const event of snapshots.flat()) byId.set(event.id, event);
  return sortLeadEvents([...byId.values()]).slice(-200);
}

export function compareActivityTimestamps(a: string, b: string): number {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isNaN(aMs) && !Number.isNaN(bMs) && aMs !== bMs) return aMs - bMs;
  if (!Number.isNaN(aMs) && !Number.isNaN(bMs)) {
    return subMillisecondRemainder(a) - subMillisecondRemainder(b);
  }
  return a.localeCompare(b);
}

function subMillisecondRemainder(timestamp: string): number {
  const fraction = timestamp.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return Number(fraction.padEnd(9, "0").slice(3, 9) || "0");
}

function readPayload(payload: Json): Record<string, Json | undefined> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
}

function readString(
  payload: Record<string, Json | undefined>,
  key: string,
): string | null {
  return typeof payload[key] === "string" ? payload[key] : null;
}

function readDisplayValue(
  payload: Record<string, Json | undefined>,
  key: string,
): string {
  const value = payload[key];
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string" || typeof value === "number")
    return humanize(String(value));
  return "updated";
}

function hasTransitionPayload(
  payload: Record<string, Json | undefined>,
): boolean {
  return (
    Object.hasOwn(payload, "from") &&
    Object.hasOwn(payload, "to") &&
    isTextTransitionValue(payload.from) &&
    isTextTransitionValue(payload.to)
  );
}

function hasAssigneeTransition(
  payload: Record<string, Json | undefined>,
): boolean {
  return (
    Object.hasOwn(payload, "from") &&
    Object.hasOwn(payload, "to") &&
    (isNonEmptyString(payload.from) || payload.from === null) &&
    (isNonEmptyString(payload.to) || payload.to === null)
  );
}

function isTextTransitionValue(value: Json | undefined): boolean {
  return value === null || isNonEmptyString(value);
}

function isNonEmptyString(value: Json | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function actorLabel(
  event: LeadEvent,
  authorEmails: Record<string, string>,
  currentUserId: string | null,
): string {
  if (event.actor_type === "ai") return "Sandra";
  if (event.actor_type === "system") return "System";
  if (!event.actor_id) return "Former teammate";
  if (event.actor_id === currentUserId) return "You";
  return event.actor_id in authorEmails
    ? shortenEmail(authorEmails[event.actor_id]!)
    : "Unknown teammate";
}

function assigneeLabel(
  value: Json | undefined,
  authorEmails: Record<string, string>,
  currentUserId: string | null,
): string {
  if (value === null || value === undefined || value === "")
    return "unassigned";
  if (typeof value !== "string") return "a teammate";
  if (value === currentUserId) return "you";
  return value in authorEmails
    ? shortenEmail(authorEmails[value]!)
    : "a teammate";
}

function formatBatchSuffix(payload: Record<string, Json | undefined>): string {
  const batchId = payload.batch_id;
  const count = payload.batch_count;
  return typeof batchId === "string" &&
    batchId.length > 0 &&
    typeof count === "number" &&
    Number.isInteger(count) &&
    count > 1
    ? ` with ${count - 1} other${count === 2 ? "" : "s"}`
    : "";
}

function formatCountedSequence(
  payload: Record<string, Json | undefined>,
): string | null {
  const count = payload.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1)
    return null;
  return count > 1 ? `${count} sequences` : "a sequence";
}

function isSingleSequencePayload(
  payload: Record<string, Json | undefined>,
): boolean {
  return (
    isNonEmptyString(payload.enrollment_id) &&
    isNonEmptyString(payload.sequence_id)
  );
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "the scheduled time"
    : EVENT_TIME_FORMATTER.format(date);
}

function withArticle(value: string): string {
  return `${/^[aeiou]/i.test(value) ? "an" : "a"} ${value}`;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ").trim() || "activity";
}

function shortenEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
