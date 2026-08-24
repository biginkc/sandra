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

export function NotesFeed(props: Props) {
  const { propertyId, currentUserId } = props;
  const { notes, authorEmails } = useLeadNotes(props);

  return (
    <div className="flex flex-col gap-3">
      <AddNoteComposer propertyId={propertyId} />
      {notes.length === 0 ? (
        <div className="text-muted-foreground border-border/60 rounded-md border border-dashed p-4 text-center text-xs">
          No notes yet. Add one so teammates can pick up the context.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {notes.map((note) => (
            <NoteEventCard
              key={note.id}
              note={note}
              authorEmail={
                note.author_user_id
                  ? (authorEmails[note.author_user_id] ?? null)
                  : null
              }
              isMine={
                note.author_user_id !== null &&
                note.author_user_id === currentUserId
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

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

export function AddNoteComposer({ propertyId }: { propertyId: string }) {
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
      className="border-border rounded-lg border bg-background p-3"
      data-testid="lead-add-note-composer"
    >
      <summary className="cursor-pointer text-sm font-semibold">
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
}: {
  note: Note;
  authorEmail: string | null;
  isMine: boolean;
}) {
  return (
    <article
      className="border-border/60 rounded-lg border bg-background p-3 text-sm"
      data-testid="lead-activity-note"
    >
      <div className="whitespace-pre-wrap break-words">{note.body}</div>
      <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span>
          {isMine ? "you" : authorEmail ? shortenEmail(authorEmail) : "system"}
        </span>
        <span>·</span>
        <span>
          {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
        </span>
      </div>
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
