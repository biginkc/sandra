"use client";

import {
  AlertTriangleIcon,
  MessageSquareIcon,
  NotebookPenIcon,
  PhoneCallIcon,
  RotateCcwIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

import {
  CallEventCard,
  type CallActivityRollupRow,
  useLeadCallRows,
} from "./lead-call-summary";
import {
  MessageBubble,
  type Message,
  useLeadMessages,
} from "./messages-thread";
import { NoteEventCard, type Note, useLeadNotes } from "./notes-feed";

export type LeadActivityEvent =
  | { source: "message"; id: string; timestamp: string; row: Message }
  | { source: "note"; id: string; timestamp: string; row: Note }
  | {
      source: "call";
      id: string;
      timestamp: string;
      row: CallActivityRollupRow;
    };

type SourceName = LeadActivityEvent["source"];

type Props = {
  propertyId: string;
  contactId: string | null;
  initialMessages: Message[];
  initialNotes: Note[];
  initialCalls: CallActivityRollupRow[];
  messageError: string | null;
  noteError: string | null;
  callError: string | null;
  authorEmails: Record<string, string>;
  currentUserId: string | null;
  currentUserEmail: string | null;
  jitterHost: string;
};

const CALL_ACTIVITY_WITH_ARTIFACTS =
  "id, created_at, started_at, outcome, disposition, recording_status, transcript_status, summary_status, jitter_attempt_id, jitter_session_id, call_recordings(*), call_transcripts(*)";

export function LeadActivityTimeline(props: Props) {
  const {
    propertyId,
    contactId,
    authorEmails,
    currentUserId,
    currentUserEmail,
    jitterHost,
  } = props;
  const [messageSnapshot, setMessageSnapshot] = useState(props.initialMessages);
  const [noteSnapshot, setNoteSnapshot] = useState(props.initialNotes);
  const [callSnapshot, setCallSnapshot] = useState(props.initialCalls);
  const [errors, setErrors] = useState<Record<SourceName, string | null>>({
    message: props.messageError,
    note: props.noteError,
    call: props.callError,
  });
  const [retrying, setRetrying] = useState<SourceName | null>(null);

  useEffect(() => {
    setMessageSnapshot(props.initialMessages);
    setNoteSnapshot(props.initialNotes);
    setCallSnapshot(props.initialCalls);
    setErrors({
      message: props.messageError,
      note: props.noteError,
      call: props.callError,
    });
  }, [
    props.callError,
    props.initialCalls,
    props.initialMessages,
    props.initialNotes,
    props.messageError,
    props.noteError,
    propertyId,
  ]);

  const messages = useLeadMessages({
    initial: messageSnapshot,
    scope: {
      contactId,
      conversationId: null,
      matchMode: "lead",
      propertyId,
    },
  });
  const { notes, authorEmails: liveAuthorEmails } = useLeadNotes({
    propertyId,
    initial: noteSnapshot,
    authorEmails,
    currentUserId,
    currentUserEmail,
  });
  const calls = useLeadCallRows({ propertyId, initialRows: callSnapshot });
  const activity = useMemo(
    () => buildLeadActivitySnapshot(messages, notes, calls, errors),
    [calls, errors, messages, notes],
  );
  const events = activity.events;
  const mostRecentOutboundId = [...messages]
    .reverse()
    .find((message) => message.direction === "outbound")?.id;
  const jitterHref = jitterHost.trim()
    ? `${jitterHost.replace(/\/$/, "")}/history?prospect_id=${propertyId}`
    : null;

  const retry = async (source: SourceName) => {
    setRetrying(source);
    const supabase = createClient();
    try {
      if (source === "message") {
        const orFilter = contactId
          ? `property_id.eq.${propertyId},and(contact_id.eq.${contactId},property_id.is.null)`
          : `property_id.eq.${propertyId}`;
        const result = await supabase
          .from("messages")
          .select("*")
          .or(orFilter)
          .order("created_at", { ascending: false })
          .limit(200);
        if (result.error) throw result.error;
        setMessageSnapshot(result.data as Message[]);
      } else if (source === "note") {
        const result = await supabase
          .from("lead_notes")
          .select("*")
          .eq("property_id", propertyId)
          .order("created_at", { ascending: false })
          .limit(200);
        if (result.error) throw result.error;
        setNoteSnapshot(result.data as Note[]);
      } else {
        const [startedResult, unstartedResult] = await Promise.all([
          supabase
            .from("call_activities")
            .select(CALL_ACTIVITY_WITH_ARTIFACTS)
            .eq("property_id", propertyId)
            .not("started_at", "is", null)
            .order("started_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(20),
          supabase
            .from("call_activities")
            .select(CALL_ACTIVITY_WITH_ARTIFACTS)
            .eq("property_id", propertyId)
            .is("started_at", null)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(20),
        ]);
        if (startedResult.error) throw startedResult.error;
        if (unstartedResult.error) throw unstartedResult.error;
        setCallSnapshot(
          selectLatestCallActivityRows([
            ...((startedResult.data ??
              []) as unknown as CallActivityRollupRow[]),
            ...((unstartedResult.data ??
              []) as unknown as CallActivityRollupRow[]),
          ]),
        );
      }
      setErrors((previous) => ({ ...previous, [source]: null }));
    } catch (error) {
      setErrors((previous) => ({
        ...previous,
        [source]: error instanceof Error ? error.message : "Retry failed",
      }));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div
      className="min-w-0"
      data-presentation="open-timeline"
      data-testid="lead-activity-timeline"
    >
      {activity.failures.length > 0 ? (
        <div className="mb-3 space-y-2">
          {activity.failures.map(({ source, detail }) => (
            <ActivitySourceFailure
              key={source}
              source={source}
              detail={detail}
              pending={retrying === source}
              onRetry={retry}
            />
          ))}
        </div>
      ) : null}

      {events.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed px-4 py-10 text-center text-sm">
          No messages, notes, or calls yet.
        </div>
      ) : (
        <div className="relative before:absolute before:top-3 before:bottom-3 before:left-[15px] before:w-px before:bg-border/70">
          {events.map((event, index) => {
            const boundary =
              index === activity.trustBoundaryIndex && activity.trustFloor ? (
                <ActivityTrustFloor timestamp={activity.trustFloor} />
              ) : null;
            const muted =
              activity.trustFloor && event.timestamp < activity.trustFloor
                ? " opacity-60"
                : "";
            if (event.source === "message") {
              const previous = events[index - 1];
              const next = events[index + 1];
              const isContinuation =
                previous?.source === "message" &&
                previous.row.direction === event.row.direction;
              const isLastInGroup =
                next?.source !== "message" ||
                next.row.direction !== event.row.direction;
              return (
                <Fragment key={`message:${event.id}`}>
                  {boundary}
                  <div className={`relative pb-4 pl-12${muted}`}>
                    <TimelineDot source="message" />
                    <MessageBubble
                      message={event.row}
                      isContinuation={isContinuation}
                      isLastInGroup={isLastInGroup}
                      isMostRecentOutbound={event.id === mostRecentOutboundId}
                      presentation="timeline"
                    />
                  </div>
                </Fragment>
              );
            }
            if (event.source === "note") {
              return (
                <Fragment key={`note:${event.id}`}>
                  {boundary}
                  <div className={`relative pb-4 pl-12${muted}`}>
                    <TimelineDot source="note" />
                    <NoteEventCard
                      note={event.row}
                      authorEmail={
                        event.row.author_user_id
                          ? (liveAuthorEmails[event.row.author_user_id] ?? null)
                          : null
                      }
                      isMine={event.row.author_user_id === currentUserId}
                      presentation="timeline"
                    />
                  </div>
                </Fragment>
              );
            }
            return (
              <Fragment key={`call:${event.id}`}>
                {boundary}
                <div className={`relative pb-4 pl-12${muted}`}>
                  <TimelineDot source="call" />
                  <CallEventCard row={event.row} jitterHref={jitterHref} />
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function normalizeLeadActivityEvents(
  messages: Message[],
  notes: Note[],
  calls: CallActivityRollupRow[],
): LeadActivityEvent[] {
  const deduplicated = new Map<string, LeadActivityEvent>();
  for (const message of messages) {
    deduplicated.set(`message:${message.id}`, {
      source: "message",
      id: message.id,
      timestamp: message.created_at,
      row: message,
    });
  }
  for (const note of notes) {
    deduplicated.set(`note:${note.id}`, {
      source: "note",
      id: note.id,
      timestamp: note.created_at,
      row: note,
    });
  }
  for (const call of calls) {
    deduplicated.set(`call:${call.id}`, {
      source: "call",
      id: call.id,
      timestamp: call.started_at ?? call.created_at,
      row: call,
    });
  }

  const sourceOrder: Record<SourceName, number> = {
    message: 0,
    note: 1,
    call: 2,
  };
  return [...deduplicated.values()].sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      sourceOrder[a.source] - sourceOrder[b.source] ||
      a.id.localeCompare(b.id),
  );
}

export function selectLatestCallActivityRows(
  rows: CallActivityRollupRow[],
): CallActivityRollupRow[] {
  return [...rows]
    .sort((a, b) => {
      const aTime = a.started_at ?? a.created_at;
      const bTime = b.started_at ?? b.created_at;
      return bTime.localeCompare(aTime) || b.id.localeCompare(a.id);
    })
    .slice(0, 20);
}

export function buildLeadActivitySnapshot(
  messages: Message[],
  notes: Note[],
  calls: CallActivityRollupRow[],
  errors: Record<SourceName, string | null>,
) {
  const sourceOrder: SourceName[] = ["message", "note", "call"];
  const boundedCutoffs = [
    messages.length >= 200 ? messages[0]?.created_at : null,
    notes.length >= 200 ? notes[0]?.created_at : null,
    calls.length >= 20
      ? calls.reduce<string | null>((oldest, call) => {
          const timestamp = call.started_at ?? call.created_at;
          return oldest === null || timestamp < oldest ? timestamp : oldest;
        }, null)
      : null,
  ].filter((timestamp): timestamp is string => Boolean(timestamp));
  const trustFloor =
    boundedCutoffs.sort((a, b) => b.localeCompare(a))[0] ?? null;
  const events = normalizeLeadActivityEvents(messages, notes, calls);
  return {
    events,
    trustFloor,
    trustBoundaryIndex:
      trustFloor === null
        ? -1
        : events.findIndex((event) => event.timestamp >= trustFloor),
    failures: sourceOrder.flatMap((source) => {
      const detail = errors[source];
      return detail ? [{ source, detail }] : [];
    }),
  };
}

function TimelineDot({ source }: { source: SourceName }) {
  const icon =
    source === "message" ? (
      <MessageSquareIcon className="size-3.5" />
    ) : source === "note" ? (
      <NotebookPenIcon className="size-3.5" />
    ) : (
      <PhoneCallIcon className="size-3.5" />
    );
  return (
    <span
      className="border-border bg-background absolute top-0 left-0 z-10 flex size-[30px] items-center justify-center rounded-full border"
      aria-hidden
    >
      {icon}
    </span>
  );
}

function ActivityTrustFloor({ timestamp }: { timestamp: string }) {
  return (
    <div
      className="relative z-10 my-4 flex items-center gap-2 text-[10px] font-bold tracking-wide text-muted-foreground uppercase before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
      data-testid="lead-activity-trust-floor"
      data-timestamp={timestamp}
    >
      <span className="max-w-[70%] text-center">
        Recent merged window · older source rows may be incomplete
      </span>
    </div>
  );
}

function ActivitySourceFailure({
  source,
  detail,
  pending,
  onRetry,
}: {
  source: SourceName;
  detail: string;
  pending: boolean;
  onRetry: (source: SourceName) => void;
}) {
  const label =
    source === "message" ? "Messages" : source === "note" ? "Notes" : "Calls";
  return (
    <div
      className="border-destructive/40 bg-destructive/5 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
      role="alert"
      data-testid={`lead-${source}-source-failure`}
    >
      <div className="flex min-w-0 gap-2">
        <AlertTriangleIcon className="text-destructive mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-bold">{label} did not load</p>
          <p className="text-muted-foreground break-words text-xs">{detail}</p>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => onRetry(source)}
        className="min-h-9"
      >
        <RotateCcwIcon className="size-3.5" />
        {pending ? "Retrying…" : `Retry ${label.toLowerCase()}`}
      </Button>
    </div>
  );
}
