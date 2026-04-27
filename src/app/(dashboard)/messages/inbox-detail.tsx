"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { buttonVariants } from "@/components/ui/button";

import { InlineReply } from "../leads/[id]/inline-reply";
import { MessagesThread } from "../leads/[id]/messages-thread";

import { AssignDropdown } from "./assign-dropdown";
import { type InboxDetail as InboxDetailData } from "./inbox-detail-data";

type Props = {
  data: InboxDetailData | null;
  /** auth.users.id → email for the assign control. */
  assigneeEmails: Record<string, string>;
  currentUserId: string | null;
};

/**
 * Right-side detail panel of the cockpit. Renders the existing
 * MessagesThread + InlineReply components — same building blocks as the
 * lead detail page so replies stay in lock-step across surfaces.
 *
 * No data is provided ⇒ render the "select a conversation" placeholder.
 *
 * ESC closes the panel by clearing ?thread from the URL. Matches the
 * Slack/Linear keyboard convention.
 */
export function InboxDetail({ data, assigneeEmails, currentUserId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const sp = new URLSearchParams(searchParams.toString());
        sp.delete("thread");
        const qs = sp.toString();
        router.replace(qs ? `/messages?${qs}` : "/messages");
        // See inbox-thread-list.tsx for the rationale — Next 16 caches the
        // RSC payload per route, so we have to force a refresh to drop
        // the side-panel data and show the empty-state placeholder.
        router.refresh();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, router, searchParams]);

  if (!data) {
    return (
      <div
        className="border-border/60 text-muted-foreground flex h-full min-h-[400px] items-center justify-center rounded-md border border-dashed p-6 text-center text-sm"
        data-testid="inbox-detail-empty"
      >
        Select a conversation to view it here.
      </div>
    );
  }

  return (
    <div
      className="border-border flex h-full flex-col rounded-md border"
      data-testid="inbox-detail-panel"
    >
      <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">
            {data.contactName ?? data.contactPhone ?? "Unknown contact"}
          </span>
          {data.propertyAddress ? (
            <span className="text-muted-foreground truncate text-[11px]">
              {data.propertyAddress}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {data.propertyId ? (
            <AssignDropdown
              propertyId={data.propertyId}
              initialAssigneeId={data.assigneeId}
              initialAssigneeEmail={
                data.assigneeId ? (assigneeEmails[data.assigneeId] ?? null) : null
              }
              currentUserId={currentUserId}
            />
          ) : null}
          {data.propertyId ? (
            <Link
              href={`/leads/${data.propertyId}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Open lead
            </Link>
          ) : null}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {/* Key on contactId so switching threads remounts the component
            and resets its internal `messages` useState. Without this,
            the previous thread's bubbles linger because the Realtime
            client preserves its initial snapshot in local state. */}
        <MessagesThread
          key={`thread-${data.contactId}`}
          initial={data.initialMessages}
          contactId={data.contactId}
          propertyId={data.propertyId ?? ""}
        />
      </div>
      {data.propertyId ? (
        <div className="border-border border-t p-3">
          <InlineReply
            key={`reply-${data.contactId}`}
            propertyId={data.propertyId}
            homeownerContactId={data.contactId}
            homeownerPhone={data.contactPhone}
          />
        </div>
      ) : (
        <div className="border-border text-muted-foreground border-t p-3 text-xs">
          This conversation has no property linked — open a lead to reply.
        </div>
      )}
    </div>
  );
}
