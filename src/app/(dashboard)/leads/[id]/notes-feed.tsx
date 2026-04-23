"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { PlusIcon } from "lucide-react";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

import { createLeadNote } from "../actions";

type Note = Database["public"]["Tables"]["lead_notes"]["Row"];

type Props = {
  propertyId: string;
  initial: Note[];
  /** Map of auth.users.id → email for display. */
  authorEmails: Record<string, string>;
  currentUserId: string | null;
  currentUserEmail: string | null;
};

/**
 * Append-only activity-notes feed. Newest at the top so VAs see recent
 * context first. Add-box stays open at the top; each note row shows
 * body + author + relative timestamp. Same subscribe-after-setAuth
 * pattern as the messages thread.
 */
export function NotesFeed({
  propertyId,
  initial,
  authorEmails: initialAuthorEmails,
  currentUserId,
  currentUserEmail,
}: Props) {
  const [notes, setNotes] = useState<Note[]>(initial);
  const [authorEmails, setAuthorEmails] = useState<Record<string, string>>(
    initialAuthorEmails,
  );
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

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
            setNotes((prev) => {
              if (prev.some((n) => n.id === row.id)) return prev;
              return [row, ...prev];
            });
          },
        )
        .subscribe();
    };
    start();

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [propertyId]);

  const add = () => {
    const trimmed = body.trim();
    if (!trimmed || pending) return;

    // No optimistic insert: Realtime INSERT typically arrives in <500ms
    // and the "Adding…" button state covers the intermediate feedback.
    // An optimistic render creates a dedup-by-id nightmare (temp-id vs
    // real UUID) that's not worth the 500ms of perceived speed.
    const draft = trimmed;
    setBody("");

    startTransition(async () => {
      const result = await callAction(createLeadNote(propertyId, draft), {
        fallbackMessage: "Could not add note",
      });
      if (!result.ok) {
        setBody(draft); // restore so user can retry
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };

  // Register current user's email the first time we see it, so the add-form
  // optimistic note can display "me" / their email while waiting for the
  // realtime payload. The server action will replace the row with one that
  // has the real org_id + author_user_id anyway.
  useEffect(() => {
    if (currentUserId && currentUserEmail && !authorEmails[currentUserId]) {
      setAuthorEmails((prev) => ({ ...prev, [currentUserId]: currentUserEmail }));
    }
  }, [currentUserId, currentUserEmail, authorEmails]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a note… (⌘/Ctrl + Enter)"
          aria-label="Add a note"
          disabled={pending}
          rows={2}
          className="border-input placeholder:text-muted-foreground focus-visible:ring-ring min-h-[44px] flex-1 rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
          maxLength={5000}
        />
        <Button
          onClick={add}
          disabled={pending || body.trim().length === 0}
          size="sm"
        >
          <PlusIcon className="mr-1 size-3.5" />
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>

      {notes.length === 0 ? (
        <div className="text-muted-foreground border-border/60 rounded-md border border-dashed p-4 text-center text-xs">
          No notes yet. Add one so teammates can pick up the context.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              authorEmail={
                n.author_user_id ? authorEmails[n.author_user_id] ?? null : null
              }
              isMine={n.author_user_id !== null && n.author_user_id === currentUserId}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteRow({
  note,
  authorEmail,
  isMine,
}: {
  note: Note;
  authorEmail: string | null;
  isMine: boolean;
}) {
  return (
    <li className="border-border/60 rounded-md border p-2.5 text-sm">
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
    </li>
  );
}

function shortenEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
