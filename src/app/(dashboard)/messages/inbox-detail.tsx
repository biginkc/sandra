"use client";

import { PhoneIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusChip, type StatusVariant } from "@/components/ui/status-chip";
import { cn } from "@/lib/utils";

import { InlineReply } from "../leads/[id]/inline-reply";
import { MessagesThread } from "../leads/[id]/messages-thread";

import { AssignDropdown } from "./assign-dropdown";
import { AssigneeSelect } from "./_components/assignee-select";
import { setOutreachDispo, type OutreachDispo } from "./dispo-actions";
import { type InboxDetail as InboxDetailData } from "./inbox-detail-data";

type Props = {
  data: InboxDetailData | null;
  /** True when the URL thread param has changed but the new server data
   *  hasn't arrived yet — render a skeleton so the user gets immediate
   *  feedback instead of stale bubbles from the previous selection. */
  isLoading?: boolean;
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

const VALID_STATUSES: StatusVariant[] = ["replying", "hot", "new", "contacted", "cold", "dead"];

function isValidStatus(s: string | null): s is StatusVariant {
  return s !== null && (VALID_STATUSES as string[]).includes(s);
}

function initialsOfName(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0]! + parts[parts.length - 1][0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function DispoBar({
  propertyId,
  initialDispo,
  currentUserId,
}: {
  propertyId: string;
  initialDispo: string | null;
  currentUserId: string | null;
}) {
  const [dispo, setDispo] = useState<OutreachDispo | null>(
    initialDispo as OutreachDispo | null,
  );
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUpDate, setFollowUpDate] = useState("");
  const [followUpAssignee, setFollowUpAssignee] = useState<string | null>(
    currentUserId,
  );
  const [pending, startTransition] = useTransition();

  function apply(
    newDispo: OutreachDispo,
    followUpAt?: string,
    assigneeId?: string | null,
  ) {
    startTransition(async () => {
      const result = await setOutreachDispo(
        propertyId,
        newDispo,
        followUpAt,
        assigneeId,
      );
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

  const isDnc = dispo === "dnc" || dispo === "opted_out";

  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] font-bold text-[#78716c]">
        How&apos;d it go?
      </span>

      <button
        onClick={() => apply("wrong_number")}
        disabled={pending}
        className={cn(
          "px-2 py-1 text-[11px] font-medium rounded-md border transition-colors",
          dispo === "wrong_number"
            ? "bg-[#f5f5f4] border-[#e5e1df] text-[#1c1917]"
            : "border-[#e5e1df] text-[#78716c] hover:bg-[#f5f5f4]",
        )}
        data-testid="dispo-wrong-number"
      >
        Wrong #
      </button>

      <button
        onClick={() => apply("not_interested")}
        disabled={pending}
        className={cn(
          "px-2 py-1 text-[11px] font-medium rounded-md border transition-colors",
          dispo === "not_interested"
            ? "bg-[#f5f5f4] border-[#e5e1df] text-[#1c1917]"
            : "border-[#e5e1df] text-[#78716c] hover:bg-[#f5f5f4]",
        )}
        data-testid="dispo-not-interested"
      >
        Not interested
      </button>

      <button
        onClick={() => apply("dnc")}
        disabled={pending}
        className={cn(
          "px-2 py-1 text-[11px] font-medium rounded-md border transition-colors",
          isDnc
            ? "bg-red-50 border-red-200 text-red-700"
            : "border-[#e5e1df] text-[#78716c] hover:bg-[#f5f5f4]",
        )}
        data-testid="dispo-dnc"
      >
        DNC
      </button>

      <Popover open={followUpOpen} onOpenChange={setFollowUpOpen}>
        <PopoverTrigger
          disabled={pending}
          className={cn(
            "px-2 py-1 text-[11px] font-medium rounded-md border transition-colors",
            dispo === "nurture" || dispo === "callback_requested"
              ? "bg-[#f5f5f4] border-[#e5e1df] text-[#1c1917]"
              : "border-[#e5e1df] text-[#78716c] hover:bg-[#f5f5f4]",
          )}
          data-testid="dispo-nurture"
        >
          Nurture
        </PopoverTrigger>
        <PopoverContent className="w-56 p-3" align="start">
          <p className="mb-2 text-xs font-medium">Follow up on</p>
          <Input
            type="date"
            value={followUpDate}
            onChange={(e) => setFollowUpDate(e.target.value)}
            className="mb-2 h-8 text-sm"
          />
          <p className="mb-2 text-xs font-medium">Assign to</p>
          <AssigneeSelect
            value={followUpAssignee}
            onChange={setFollowUpAssignee}
            currentUserId={currentUserId}
            disabled={pending}
            className="mb-3"
          />
          <Button
            size="sm"
            className="w-full"
            disabled={!followUpDate || pending}
            onClick={() => {
              apply(
                "nurture",
                new Date(followUpDate).toISOString(),
                followUpAssignee,
              );
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
            isDnc ? "text-destructive" : "text-[#78716c]",
          )}
        >
          {DISPO_LABELS[dispo] ?? dispo}
        </span>
      ) : null}
    </div>
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
export function InboxDetail({
  data,
  isLoading,
  assigneeEmails,
  currentUserId,
}: Props) {
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

  if (isLoading) {
    return <InboxDetailSkeleton />;
  }

  if (!data) {
    return (
      <div
        className="border-border bg-white text-[#78716c] flex h-full min-h-[400px] items-center justify-center rounded-xl border border-dashed p-6 text-center text-sm"
        data-testid="inbox-detail-empty"
      >
        Select a conversation to view it here.
      </div>
    );
  }

  const assigneeEmail = data.assigneeId
    ? (assigneeEmails[data.assigneeId] ?? null)
    : null;
  const isMine =
    data.assigneeId !== null && data.assigneeId === currentUserId;
  const assignedLabel = !data.assigneeId
    ? "Unassigned"
    : isMine
      ? "Me"
      : (assigneeEmail ?? "Teammate");
  const phoneHref = data.contactPhone ? `tel:${data.contactPhone}` : null;

  return (
    <div
      className="bg-white border border-border rounded-xl flex h-full flex-col overflow-hidden"
      data-testid="inbox-detail-panel"
    >
      <header className="border-b border-border bg-white flex items-center justify-between gap-3 px-6 py-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 rounded-full bg-[#f5f5f4] border border-[#e5e1df] flex items-center justify-center text-base font-bold text-[#111827] shrink-0">
            {initialsOfName(data.contactName)}
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[18px] font-bold leading-tight text-[#1c1917]">
                {data.contactName ?? data.contactPhone ?? "Unknown contact"}
              </h2>
              {isValidStatus(data.propertyStatus) && (
                <StatusChip status={data.propertyStatus} />
              )}
            </div>
            <p className="text-[13px] text-[#78716c] flex items-center gap-2 min-w-0">
              {data.propertyAddress ? (
                <span className="truncate">{data.propertyAddress}</span>
              ) : (
                <span className="truncate italic">No property linked</span>
              )}
              <span aria-hidden className="text-[#a8a29e]">·</span>
              <span className="shrink-0 font-medium text-[#111827]">
                Assigned: {assignedLabel}
              </span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {phoneHref ? (
            <a
              href={phoneHref}
              aria-label={`Call ${data.contactName ?? data.contactPhone ?? "contact"}`}
              data-testid="inbox-detail-phone"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[#78716c] hover:bg-[#f5f5f4] hover:text-[#111827] transition-colors"
            >
              <PhoneIcon className="h-4 w-4" />
            </a>
          ) : null}
          {data.propertyId ? (
            <AssignDropdown
              propertyId={data.propertyId}
              initialAssigneeId={data.assigneeId}
              initialAssigneeEmail={assigneeEmail}
              currentUserId={currentUserId}
            />
          ) : null}
          {data.propertyId ? (
            <Link
              href={`/leads/${data.propertyId}`}
              data-testid="inbox-detail-open-lead"
              className={cn(
                "inline-flex items-center gap-1 rounded-full border border-[#e5e1df] bg-white px-4 py-1.5",
                "text-[12px] font-bold text-[#1c1917] transition-colors hover:bg-[#f5f5f4]",
              )}
            >
              Open lead
            </Link>
          ) : null}
        </div>
      </header>
      <div
        className="flex-1 overflow-y-auto px-6 py-5 bg-[#faf9f8]"
        data-testid="inbox-detail-scroll"
      >
        {/* Key on the resolved thread so switching conversations remounts
            the component and resets its local snapshot immediately. */}
        <MessagesThread
          key={`thread-${data.threadId}`}
          initial={data.initialMessages}
          contactId={data.contactId}
          conversationId={data.conversationId}
          propertyId={data.propertyId}
        />
      </div>
      {data.propertyId ? (
        <>
          <div className="border-t border-border bg-white flex items-center px-6 py-2">
            <DispoBar
              key={`dispo-${data.propertyId}`}
              propertyId={data.propertyId}
              initialDispo={data.outreachDispo}
              currentUserId={currentUserId}
            />
          </div>
          <div className="border-t border-border bg-white px-6 py-4">
            <InlineReply
              key={`reply-${data.threadId}`}
              propertyId={data.propertyId}
              homeownerContactId={data.contactId}
              homeownerPhone={data.contactPhone}
            />
          </div>
        </>
      ) : (
        <div className="border-t border-border bg-white text-[#78716c] p-4 text-xs">
          This conversation has no property linked — open a lead to reply.
        </div>
      )}
    </div>
  );
}

/**
 * Detail-panel skeleton — shown while the URL thread param has changed
 * but the new server data hasn't landed yet. Mirrors the rough shape of
 * the loaded panel (header, message bubbles, dispo bar, composer) so the
 * transition feels structural rather than a "blank flash". Uses the
 * Tailwind `animate-pulse` utility for the breathing effect.
 */
function InboxDetailSkeleton() {
  return (
    <div
      className="bg-white border border-border rounded-xl flex h-full flex-col overflow-hidden"
      data-testid="inbox-detail-loading"
      aria-busy="true"
      aria-live="polite"
    >
      <header className="border-b border-border bg-white flex items-center justify-between gap-3 px-6 py-4">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div className="h-12 w-12 shrink-0 rounded-full bg-[#f5f5f4] animate-pulse" />
          <div className="flex flex-col gap-2 min-w-0 flex-1">
            <div className="h-5 w-44 max-w-full bg-[#f5f5f4] rounded animate-pulse" />
            <div className="h-3 w-64 max-w-full bg-[#f5f5f4] rounded animate-pulse" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="h-9 w-9 rounded-full bg-[#f5f5f4] animate-pulse" />
          <div className="h-8 w-24 rounded-full bg-[#f5f5f4] animate-pulse" />
          <div className="h-8 w-24 rounded-full bg-[#f5f5f4] animate-pulse" />
        </div>
      </header>
      <div className="flex-1 overflow-hidden px-6 py-5 bg-[#faf9f8] flex flex-col gap-4">
        <div className="self-center h-5 w-32 rounded-full bg-[#f5f5f4] animate-pulse" />
        <div className="self-start h-12 w-3/5 rounded-2xl rounded-tl-none bg-[#f5f5f4] animate-pulse" />
        <div className="self-end h-16 w-3/5 rounded-2xl rounded-tr-none bg-[#111827]/15 animate-pulse" />
        <div className="self-start h-10 w-2/5 rounded-2xl rounded-tl-none bg-[#f5f5f4] animate-pulse" />
        <div className="self-end h-12 w-1/2 rounded-2xl rounded-tr-none bg-[#111827]/15 animate-pulse" />
      </div>
      <div className="border-t border-border bg-white flex items-center gap-3 px-6 py-2.5">
        <div className="h-3 w-12 bg-[#f5f5f4] rounded animate-pulse" />
        <div className="h-7 w-20 bg-[#f5f5f4] rounded-md animate-pulse" />
        <div className="h-7 w-24 bg-[#f5f5f4] rounded-md animate-pulse" />
        <div className="h-7 w-16 bg-[#f5f5f4] rounded-md animate-pulse" />
        <div className="h-7 w-20 bg-[#f5f5f4] rounded-md animate-pulse" />
      </div>
      <div className="border-t border-border bg-white px-6 py-4">
        <div className="h-24 w-full rounded-xl border border-[#e5e1df] bg-[#fdfcfb] animate-pulse" />
      </div>
      <span className="sr-only">Loading conversation…</span>
    </div>
  );
}
