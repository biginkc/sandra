"use client";

import { AddNoteComposer, NoteEventCard, useLeadNotes } from "@/app/(dashboard)/leads/[id]/notes-feed";
import { MessagesThread } from "@/app/(dashboard)/leads/[id]/messages-thread";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { CallScreenMessage, CallScreenNote, Section } from "./types";

export type HistoryPanelProps = {
  propertyId: string;
  contactId: string | null;
  viewerUserId: string;
  notes: Section<CallScreenNote[]>;
  messages: Section<CallScreenMessage[]>;
};

/**
 * Notes | Texts, reusing the lead page's feed pieces. Texts are read-only here and viewing them
 * never marks them read (that would clear the tier-2 unread-inbound ranking signal).
 */
export function HistoryPanel({ propertyId, contactId, viewerUserId, notes, messages }: HistoryPanelProps) {
  return (
    <section data-testid="history-panel" className="flex flex-col gap-2 rounded-[16px] border border-border bg-card p-4">
      <Tabs defaultValue="notes">
        <TabsList>
          <TabsTrigger value="notes" data-testid="history-tab-notes">Notes</TabsTrigger>
          <TabsTrigger value="texts" data-testid="history-tab-texts">Texts</TabsTrigger>
        </TabsList>
        <TabsContent value="notes" data-testid="history-notes">
          {notes.ok ? (
            <NotesTab propertyId={propertyId} viewerUserId={viewerUserId} initial={notes.data} />
          ) : (
            <p role="alert" className="text-destructive text-sm">{notes.message}</p>
          )}
        </TabsContent>
        <TabsContent value="texts" data-testid="history-texts">
          {messages.ok ? (
            messages.data.length === 0 ? (
              <p className="text-muted-foreground text-sm">No texts yet.</p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <MessagesThread initial={messages.data} contactId={contactId} propertyId={propertyId} />
              </div>
            )
          ) : (
            <p role="alert" className="text-destructive text-sm">{messages.message}</p>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

function NotesTab({ propertyId, viewerUserId, initial }: { propertyId: string; viewerUserId: string; initial: CallScreenNote[] }) {
  const { notes, authorEmails } = useLeadNotes({ propertyId, initial, authorEmails: {}, currentUserId: viewerUserId, currentUserEmail: null });
  return (
    <div className="flex flex-col gap-3">
      <AddNoteComposer propertyId={propertyId} compact />
      {notes.length === 0 ? (
        <p className="text-muted-foreground text-sm">No notes yet.</p>
      ) : (
        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {notes.map((note) => (
            <li key={note.id}>
              <NoteEventCard note={note} authorEmail={authorEmails[note.author_user_id ?? ""] ?? null} isMine={note.author_user_id === viewerUserId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
