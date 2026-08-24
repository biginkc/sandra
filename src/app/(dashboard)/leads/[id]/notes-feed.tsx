"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

import { createLeadNote } from "../actions";

export type Note = Database["public"]["Tables"]["lead_notes"]["Row"];

type Props = {
  propertyId: string;
  initial: Note[];
  authorEmails: Record<string, string>;
  currentUserId: string | null;
  currentUserEmail: string | null;
};

export function useLeadNotes({
  propertyId,
  initial,
  authorEmails: initialAuthorEmails,
  currentUserId,
  currentUserEmail,
}: Props): { notes: Note[]; authorEmails: Record<string, string> } {
  const [notes, setNotes] = useState<Note[]>(() => sortNotes(initial));
  const authorEmails = useMemo(
    () =>
      currentUserId && currentUserEmail && !initialAuthorEmails[currentUserId]
        ? { ...initialAuthorEmails, [currentUserId]: currentUserEmail }
        : initialAuthorEmails,
    [currentUserEmail, currentUserId, initialAuthorEmails],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Route transitions replace the server snapshot underneath the subscription.
    setNotes(sortNotes(initial));
  }, [initial, propertyId]);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const start = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted) return;

      channel = supabase
        .channel(`lead_notes:${propertyId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "lead_notes",
            filter: `property_id=eq.${propertyId}`,
          },
          (payload) => {
            const row = payload.new as Note;
            setNotes((previous) =>
              sortNotes([
                row,
                ...previous.filter((note) => note.id !== row.id),
              ]).slice(-200),
            );
          },
        )
        .subscribe();
    };
    void start();

    return () => {
      mounted = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [propertyId]);

  return { notes, authorEmails };
}

export function AddNoteComposer({
  propertyId,
  compact = false,
}: {
  propertyId: string;
  compact?: boolean;
}) {
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  const add = () => {
    const trimmed = body.trim();
    if (!trimmed || pending) return;
    const draft = trimmed;
    setBody("");

    startTransition(async () => {
      const result = await callAction(createLeadNote(propertyId, draft), {
        fallbackMessage: "Could not add note",
      });
      if (!result.ok) setBody(draft);
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      add();
    }
  };

  return (
    <details
      className={
        compact
          ? "open:bg-amber-50 open:border-amber-200 min-w-0 open:col-span-2 open:col-start-1 open:w-full open:rounded-xl open:border open:p-2.5"
          : "border-border rounded-lg border bg-background p-3"
      }
      data-testid="lead-add-note-composer"
    >
      <summary
        className={
          compact
            ? "text-muted-foreground cursor-pointer whitespace-nowrap text-[11px] font-bold underline underline-offset-2"
            : "cursor-pointer text-sm font-semibold"
        }
      >
        + Add note
      </summary>
      <div className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a note… (⌘/Ctrl + Enter)"
          aria-label="Add a note"
          disabled={pending}
          rows={2}
          className="border-input placeholder:text-muted-foreground focus-visible:ring-ring min-h-[72px] min-w-0 flex-1 rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
          maxLength={5000}
        />
        <Button
          onClick={add}
          disabled={pending || body.trim().length === 0}
          size="sm"
          className="min-h-9"
        >
          <PlusIcon className="mr-1 size-3.5" />
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
    </details>
  );
}

export function NoteEventCard({
  note,
  authorEmail,
  isMine,
  presentation = "card",
}: {
  note: Note;
  authorEmail: string | null;
  isMine: boolean;
  presentation?: "card" | "timeline";
}) {
  const author = isMine
    ? "you"
    : authorEmail
      ? shortenEmail(authorEmail)
      : note.author_user_id
        ? "unknown teammate"
        : "system";
  return (
    <article
      className={
        presentation === "timeline"
          ? "max-w-[560px] text-sm"
          : "border-border/60 rounded-lg border bg-background p-3 text-sm"
      }
      data-testid="lead-activity-note"
    >
      {presentation === "timeline" ? (
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-bold">Note · {author}</span>
          <time
            className="text-muted-foreground text-[11px]"
            dateTime={note.created_at}
          >
            {formatDistanceToNow(new Date(note.created_at), {
              addSuffix: true,
            })}
          </time>
        </div>
      ) : null}
      <div
        className={
          presentation === "timeline"
            ? "border-amber-300 bg-amber-50 whitespace-pre-wrap break-words rounded-xl border px-3.5 py-2.5 text-amber-950"
            : "whitespace-pre-wrap break-words"
        }
      >
        {note.body}
      </div>
      {presentation === "card" ? (
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span>{author}</span>
          <span>·</span>
          <span>
            {formatDistanceToNow(new Date(note.created_at), {
              addSuffix: true,
            })}
          </span>
        </div>
      ) : null}
    </article>
  );
}

function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

function shortenEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
