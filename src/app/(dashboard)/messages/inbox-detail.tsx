"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Ban, Clock, PhoneOff, ThumbsDown } from "lucide-react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { InlineReply } from "../leads/[id]/inline-reply";
import { MessagesThread } from "../leads/[id]/messages-thread";

import { AssignDropdown } from "./assign-dropdown";
import { setOutreachDispo, type OutreachDispo } from "./dispo-actions";
import { type InboxDetail as InboxDetailData } from "./inbox-detail-data";

type Props = {
  data: InboxDetailData | null;
  /** auth.users.id → email for the assign control. */
  assigneeEmails: Record<string, string>;
  currentUserId: string | null;
};

const DISPO_LABELS: Record<OutreachDispo, string> = {
  wrong_number: "Wrong #",
  bad_number: "Bad #",
  not_interested: "Not interested",
  opted_out: "Opted out",
  dnc: "Do not contact",
  nurture: "Nurture",
  callback_requested: "Callback",
};

function DispoBar({
  propertyId,
  initialDispo,
}: {
  propertyId: string;
  initialDispo: string | null;
}) {
  const [dispo, setDispo] = useState<OutreachDispo | null>(
    initialDispo as OutreachDispo | null,
  );
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUpDate, setFollowUpDate] = useState("");
  const [pending, startTransition] = useTransition();

  function apply(newDispo: OutreachDispo, followUpAt?: string) {
    startTransition(async () => {
      const result = await setOutreachDispo(propertyId, newDispo, followUpAt);
      if (result.ok) {
        setDispo(newDispo);
        if (newDispo === "wrong_number") {
          toast.info("Marked wrong number — consider skip-tracing a new number.");
        }
      } else {
        toast.error(result.error);
      }
    });
  }

  const btnBase = "rounded p-2 transition-colors disabled:opacity-40";
  const btnIdle = "text-foreground/70 hover:text-foreground hover:bg-muted";
  const btnActive = "bg-muted text-foreground";
  const btnDanger = "bg-destructive/10 text-destructive";

  const isDnc = dispo === "dnc" || dispo === "opted_out";

  return (
    <TooltipProvider delay={400}>
      <div className="flex items-center gap-0.5">
        <span className="text-foreground/80 mr-2 text-xs font-medium">Dispo:</span>

        <Tooltip>
          <TooltipTrigger
            onClick={() => apply("wrong_number")}
            disabled={pending}
            className={cn(btnBase, dispo === "wrong_number" ? btnActive : btnIdle)}
            data-testid="dispo-wrong-number"
          >
            <PhoneOff className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>Wrong number</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            onClick={() => apply("not_interested")}
            disabled={pending}
            className={cn(btnBase, dispo === "not_interested" ? btnActive : btnIdle)}
            data-testid="dispo-not-interested"
          >
            <ThumbsDown className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>Not interested</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            onClick={() => apply("dnc")}
            disabled={pending}
            className={cn(btnBase, isDnc ? btnDanger : btnIdle)}
            data-testid="dispo-dnc"
          >
            <Ban className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>Do not contact</TooltipContent>
        </Tooltip>

        <Popover open={followUpOpen} onOpenChange={setFollowUpOpen}>
          <PopoverTrigger
            disabled={pending}
            className={cn(
              btnBase,
              dispo === "nurture" || dispo === "callback_requested" ? btnActive : btnIdle,
            )}
            data-testid="dispo-nurture"
            title="Follow up later"
          >
            <Clock className="h-4 w-4" />
          </PopoverTrigger>
          <PopoverContent className="w-52 p-3" align="start">
            <p className="mb-2 text-xs font-medium">Follow up on</p>
            <Input
              type="date"
              value={followUpDate}
              onChange={(e) => setFollowUpDate(e.target.value)}
              className="mb-2 h-8 text-sm"
            />
            <Button
              size="sm"
              className="w-full"
              disabled={!followUpDate || pending}
              onClick={() => {
                apply("nurture", new Date(followUpDate).toISOString());
                setFollowUpOpen(false);
              }}
            >
              Set
            </Button>
          </PopoverContent>
        </Popover>

        {dispo ? (
          <span
            className={cn(
              "ml-1 text-[10px] font-medium",
              isDnc ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {DISPO_LABELS[dispo] ?? dispo}
          </span>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

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
        <>
          <div className="border-border flex items-center border-t px-3 py-1.5">
            <DispoBar
              key={`dispo-${data.propertyId}`}
              propertyId={data.propertyId}
              initialDispo={data.outreachDispo}
            />
          </div>
          <div className="border-border border-t p-3">
            <InlineReply
              key={`reply-${data.contactId}`}
              propertyId={data.propertyId}
              homeownerContactId={data.contactId}
              homeownerPhone={data.contactPhone}
            />
          </div>
        </>
      ) : (
        <div className="border-border text-muted-foreground border-t p-3 text-xs">
          This conversation has no property linked — open a lead to reply.
        </div>
      )}
    </div>
  );
}
