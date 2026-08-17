"use client";

import {
  ArrowLeftIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PhoneIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { toast } from "sonner";

import { BookAppointmentPopover } from "@/components/appointments/book-appointment-popover";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { copyToClipboard } from "@/lib/csv/export";
import { formatPhoneE164 } from "@/lib/phone-format";
import { cn } from "@/lib/utils";

import { InlineReply } from "../leads/[id]/inline-reply";
import { MessagesThread } from "../leads/[id]/messages-thread";

import { AssignDropdown } from "./assign-dropdown";
import {
  moveMessageThreadToLead,
  setOutreachDispo,
  type OutreachDispo,
} from "./dispo-actions";
import { type InboxDetail as InboxDetailData } from "./inbox-detail-data";
import { ResolveToPropertyDialog } from "./resolve-to-property-dialog";
import { MessageStageChip } from "./stage-chip";
import type { Database } from "@/lib/supabase/types";

type Props = {
  data: InboxDetailData | null;
  /** True when the URL thread param has changed but the new server data
   *  hasn't arrived yet — render a skeleton so the user gets immediate
   *  feedback instead of stale bubbles from the previous selection. */
  isLoading?: boolean;
  /** auth.users.id → email for the assign control. */
  assigneeEmails: Record<string, string>;
  currentUserId: string | null;
  /** Narrow list/detail navigation. The parent owns focus restoration. */
  onBackToList?: () => void;
};

const DISPO_LABELS: Record<string, string> = {
  wrong_number: "Wrong #",
  bad_number: "Bad / disconnected #",
  not_interested: "Not interested",
  needs_sequence: "Needs sequence",
  opted_out: "SMS opted out",
  dnc: "Do not call",
  nurture: "Follow up",
  callback_requested: "Lead task requested",
  booked_appointment: "Booked appointment",
};

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type ReplyRefreshGate = {
  threadId: string;
  initialMessages: MessageRow[];
};

function initialsOfName(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2)
    return (parts[0][0]! + parts[parts.length - 1][0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function outcomeButtonClass(
  isActive: boolean,
  activeClass = "bg-[#f5f5f4] border-[#e5e1df] text-[#1c1917]",
) {
  return cn(
    "min-h-11 px-3 py-1 text-[11px] font-medium rounded-md border transition-colors md:min-h-0 md:px-2",
    isActive
      ? activeClass
      : "border-[#e5e1df] text-[#78716c] hover:bg-[#f5f5f4]",
  );
}

function DispoBar({
  propertyId,
  contactId,
  propertyAddress,
  initialDispo,
  propertyStatus,
  currentUserId,
  onPermanentDnc,
}: {
  propertyId: string;
  contactId: string;
  propertyAddress: string | null;
  initialDispo: string | null;
  propertyStatus: string | null;
  currentUserId: string | null;
  onPermanentDnc: () => void;
}) {
  const router = useRouter();
  const [dispo, setDispo] = useState<string | null>(initialDispo);
  const [wasMovedToLead, setWasMovedToLead] = useState(false);
  const [pending, startTransition] = useTransition();
  const isLead = propertyStatus !== "prospect" || wasMovedToLead;

  function apply(newDispo: OutreachDispo) {
    startTransition(async () => {
      const result = await setOutreachDispo(propertyId, newDispo);
      if (result.ok) {
        setDispo(newDispo);
        if (newDispo === "dnc") {
          onPermanentDnc();
        }
        if (newDispo === "wrong_number") {
          toast.info(
            "Marked wrong number — consider skip-tracing a new number.",
          );
        }
      } else {
        toast.error(result.error);
      }
    });
  }

  function moveToLead() {
    startTransition(async () => {
      const result = await moveMessageThreadToLead(propertyId);
      if (result.ok) {
        setWasMovedToLead(true);
        toast.success(
          result.alreadyQualified ? "Opening lead" : "Moved to lead",
        );
        router.push(`/leads/${propertyId}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const isDnc = dispo === "dnc" || dispo === "opted_out";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-bold text-[#78716c]">
        How&apos;d it go?
      </span>

      <button
        onClick={() => apply("wrong_number")}
        disabled={pending}
        className={outcomeButtonClass(dispo === "wrong_number")}
        data-testid="dispo-wrong-number"
      >
        Wrong number
      </button>

      <button
        onClick={() => apply("not_interested")}
        disabled={pending}
        className={outcomeButtonClass(dispo === "not_interested")}
        data-testid="dispo-not-interested"
      >
        Not interested
      </button>

      <button
        onClick={() => apply("nurture")}
        disabled={pending}
        className={outcomeButtonClass(
          dispo === "nurture",
          "bg-blue-50 border-blue-200 text-blue-800",
        )}
        data-testid="dispo-follow-up"
      >
        Follow up
      </button>

      <button
        onClick={() => apply("dnc")}
        disabled={pending}
        className={outcomeButtonClass(
          isDnc,
          "bg-red-50 border-red-200 text-red-700",
        )}
        data-testid="dispo-dnc"
      >
        Do not call
      </button>

      <button
        onClick={() => apply("needs_sequence")}
        disabled={pending}
        className={outcomeButtonClass(
          dispo === "needs_sequence",
          "bg-teal-50 border-teal-200 text-teal-800",
        )}
        data-testid="dispo-needs-sequence"
      >
        Needs sequence
      </button>

      <button
        onClick={moveToLead}
        disabled={pending || isLead}
        className="rounded-md border border-[#111827] bg-[#111827] px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[#292524] disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="message-move-to-lead"
        title={isLead ? "Already a lead" : undefined}
      >
        Move to Lead
      </button>

      <BookAppointmentPopover
        propertyId={propertyId}
        contactId={contactId}
        subjectLabel={propertyAddress ?? undefined}
        currentUserId={currentUserId}
        triggerLabel="Book appt"
        disabled={pending}
        onBooked={() => setDispo("booked_appointment")}
      />

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              disabled={pending}
              className="inline-flex items-center gap-1 rounded-md border border-[#e5e1df] px-2 py-1 text-[11px] font-medium text-[#78716c] transition-colors hover:bg-[#f5f5f4] hover:text-[#1c1917]"
              data-testid="dispo-more"
            >
              More
              <ChevronDownIcon className="h-3 w-3" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onClick={() => apply("bad_number")}
            data-testid="dispo-bad-number"
          >
            Bad / disconnected #
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => apply("opted_out")}
            data-testid="dispo-opted-out"
          >
            SMS opt-out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
  onBackToList,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [openLeadPending, startOpenLeadTransition] = useTransition();
  const [resolveOpen, setResolveOpen] = useState(false);
  const [replyRefreshGate, setReplyRefreshGate] =
    useState<ReplyRefreshGate | null>(null);
  const [optimisticallyLockedThreadId, setOptimisticallyLockedThreadId] =
    useState<string | null>(null);

  const closeDetail = useCallback(() => {
    if (onBackToList) {
      onBackToList();
      return;
    }
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("thread");
    const qs = sp.toString();
    router.replace(qs ? `/messages?${qs}` : "/messages", { scroll: false });
    router.refresh();
  }, [onBackToList, router, searchParams]);

  const handlePermanentDnc = useCallback(() => {
    if (!data) return;
    setOptimisticallyLockedThreadId(data.threadId);
    router.refresh();
  }, [data, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeDetail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDetail, data]);

  if (isLoading) {
    return <InboxDetailSkeleton onBackToList={closeDetail} />;
  }

  if (!data) {
    return (
      <div
        className="border-border bg-white text-[#78716c] flex h-full min-h-[400px] flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-6 text-center text-sm"
        data-testid="inbox-detail-empty"
      >
        <span>Select a conversation to view it here.</span>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 md:hidden"
          onClick={closeDetail}
        >
          <ArrowLeftIcon className="size-4" />
          All conversations
        </Button>
      </div>
    );
  }

  const assigneeEmail = data.assigneeId
    ? (assigneeEmails[data.assigneeId] ?? null)
    : null;
  const isMine = data.assigneeId !== null && data.assigneeId === currentUserId;
  const assignedLabel = !data.assigneeId
    ? "Unassigned"
    : isMine
      ? "Me"
      : (assigneeEmail ?? "Teammate");
  const propertyIsLead = data.propertyStatus !== "prospect";
  const recordLabel = propertyIsLead ? "lead" : "prospect";
  const openLeadFromHeader = () => {
    if (!data.propertyId) return;
    startOpenLeadTransition(() => {
      router.push(`/leads/${data.propertyId}`);
    });
  };
  const copy = async (value: string, label: string) => {
    const ok = await copyToClipboard(value);
    if (ok) {
      toast.success(`${label} copied`);
    } else {
      toast.error(`Could not copy ${label.toLowerCase()}`);
    }
  };
  const absolutePath = (path: string) =>
    typeof window === "undefined"
      ? path
      : new URL(path, window.location.origin).toString();
  const conversationLink = absolutePath(
    `/messages?thread=${encodeURIComponent(data.threadId)}`,
  );
  const recordLink = data.propertyId
    ? absolutePath(`/leads/${data.propertyId}`)
    : null;
  const phoneHref = data.threadCustomerPhone
    ? `tel:${data.threadCustomerPhone}`
    : null;
  const hasBadThreadNumber =
    data.outreachDispo === "wrong_number" ||
    data.outreachDispo === "bad_number";
  const isSmsOptedOut =
    data.contactSmsOptedOut ||
    data.outreachDispo === "dnc" ||
    data.outreachDispo === "opted_out";
  const isSmsRestricted =
    data.contactDoNotContact || isSmsOptedOut || hasBadThreadNumber;
  const isPermanentlyLocked =
    data.isDncLocked || optimisticallyLockedThreadId === data.threadId;
  const canCall =
    Boolean(phoneHref) &&
    !isPermanentlyLocked &&
    !data.contactDoNotContact &&
    !hasBadThreadNumber;
  const replyRefreshPending =
    replyRefreshGate?.threadId === data.threadId &&
    replyRefreshGate.initialMessages === data.initialMessages;
  const handleLiveMessage = () => {
    setReplyRefreshGate({
      threadId: data.threadId,
      initialMessages: data.initialMessages,
    });
    router.refresh();
  };

  return (
    <div
      className="bg-white border border-border rounded-xl flex h-full flex-col overflow-hidden"
      data-testid="inbox-detail-panel"
    >
      <header className="border-b border-border bg-white flex flex-col items-stretch justify-between gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-6">
        <div className="flex min-w-0 flex-col gap-2">
          <button
            type="button"
            onClick={closeDetail}
            className="inline-flex min-h-11 w-fit items-center gap-1 text-[12px] font-bold text-[#78716c] hover:text-[#1c1917] md:hidden"
            aria-label="All conversations"
            data-testid="inbox-detail-back"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            All conversations
          </button>
          <div className="flex min-w-0 items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-[#f5f5f4] border border-[#e5e1df] flex items-center justify-center text-base font-bold text-[#111827] shrink-0">
              {initialsOfName(data.contactName)}
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-[18px] font-bold leading-tight text-[#1c1917]">
                  {data.contactName ?? data.contactPhone ?? "Unknown contact"}
                </h2>
                <MessageStageChip
                  status={data.propertyStatus}
                  historical={isPermanentlyLocked}
                />
              </div>
              <p className="text-[13px] text-[#78716c] flex items-center gap-2 min-w-0">
                {data.propertyAddress ? (
                  <span className="truncate">{data.propertyAddress}</span>
                ) : (
                  <span className="truncate italic">No property linked</span>
                )}
                <span aria-hidden className="text-[#a8a29e]">
                  ·
                </span>
                <span className="shrink-0 font-medium text-[#111827]">
                  Assigned: {assignedLabel}
                </span>
              </p>
              <p
                className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-[#78716c]"
                title={[
                  data.threadCustomerPhone
                    ? `Customer: ${data.threadCustomerPhone}`
                    : null,
                  data.threadBusinessPhone
                    ? `Sandra: ${data.threadBusinessPhone}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                {data.threadCustomerPhone ? (
                  <>
                    <span className="shrink-0">Texting</span>
                    <span className="truncate font-bold tabular-nums text-[#1c1917]">
                      {formatPhoneE164(data.threadCustomerPhone)}
                    </span>
                  </>
                ) : (
                  <span className="italic">No SMS number on this thread</span>
                )}
                {data.threadBusinessPhone ? (
                  <>
                    <span aria-hidden className="text-[#a8a29e]">
                      via
                    </span>
                    <span className="truncate tabular-nums">
                      {formatPhoneE164(data.threadBusinessPhone)}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {data.propertyId && !isPermanentlyLocked ? (
            <AssignDropdown
              propertyId={data.propertyId}
              initialAssigneeId={data.assigneeId}
              initialAssigneeEmail={assigneeEmail}
              currentUserId={currentUserId}
            />
          ) : null}
          {data.propertyId ? (
            <Button
              type="button"
              onClick={openLeadFromHeader}
              disabled={openLeadPending}
              variant="outline"
              size="sm"
              data-testid="inbox-detail-open-lead"
              aria-label={`Open ${recordLabel}`}
            >
              <ExternalLinkIcon className="h-3.5 w-3.5" />
              Open {recordLabel}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Conversation actions"
                  data-testid="inbox-detail-more"
                >
                  <MoreHorizontalIcon className="h-4 w-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem
                onClick={() => copy(conversationLink, "Conversation link")}
                data-testid="copy-conversation-link"
              >
                <CopyIcon className="h-4 w-4" />
                Copy conversation link
              </DropdownMenuItem>
              {recordLink ? (
                <DropdownMenuItem
                  onClick={() =>
                    copy(recordLink, `${capitalize(recordLabel)} link`)
                  }
                  data-testid="copy-record-link"
                >
                  <CopyIcon className="h-4 w-4" />
                  Copy {recordLabel} link
                </DropdownMenuItem>
              ) : null}
              {data.threadCustomerPhone ? (
                <DropdownMenuItem
                  onClick={() =>
                    copy(data.threadCustomerPhone!, "Phone number")
                  }
                  data-testid="copy-phone-number"
                >
                  <CopyIcon className="h-4 w-4" />
                  Copy phone number
                </DropdownMenuItem>
              ) : null}
              {canCall ? (
                <DropdownMenuItem
                  render={
                    <a
                      href={phoneHref!}
                      aria-label={`Open phone app to call ${formatPhoneE164(data.threadCustomerPhone!)}`}
                      data-testid="inbox-detail-phone"
                    >
                      <PhoneIcon className="h-4 w-4" />
                      Call {formatPhoneE164(data.threadCustomerPhone!)}
                    </a>
                  }
                />
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {isPermanentlyLocked ? (
        <div
          className="border-b-2 border-[#1c1917] bg-[#f5f5f4] px-4 py-3 text-sm sm:px-6"
          role="status"
          data-testid="messages-permanent-dnc-lock"
        >
          <div className="font-mono text-xs font-black tracking-wide text-[#1c1917]">
            ⊘ PERMANENT DO NOT CONTACT
          </div>
          <p className="mt-1 text-xs text-[#57534e]">
            This property is permanently locked and read-only. Historical
            messages remain visible, but outreach and record-changing controls
            have been removed.
          </p>
        </div>
      ) : data.contactDoNotContact ? (
        <RestrictionNotice>
          Contact suppressed — outreach is blocked for this contact. The
          property itself is not permanently locked.
        </RestrictionNotice>
      ) : isSmsOptedOut ? (
        <RestrictionNotice>
          SMS disabled — this contact opted out. This is not the permanent
          organization-wide DNC lock; non-SMS work remains available.
        </RestrictionNotice>
      ) : hasBadThreadNumber ? (
        <RestrictionNotice>
          SMS and calling are disabled for this thread number because it is
          marked{" "}
          {data.outreachDispo === "wrong_number"
            ? "wrong"
            : "bad or disconnected"}
          .
        </RestrictionNotice>
      ) : null}
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
          onLiveMessage={handleLiveMessage}
        />
      </div>
      {data.propertyId && !isPermanentlyLocked ? (
        <>
          {!data.contactDoNotContact ? (
            <div className="border-t border-border bg-white flex items-center px-6 py-2">
              <DispoBar
                key={`dispo-${data.propertyId}`}
                propertyId={data.propertyId}
                contactId={data.contactId}
                propertyAddress={data.propertyAddress}
                initialDispo={data.outreachDispo}
                propertyStatus={data.propertyStatus}
                currentUserId={currentUserId}
                onPermanentDnc={handlePermanentDnc}
              />
            </div>
          ) : null}
          <div className="border-t border-border bg-white px-6 py-4">
            {isSmsRestricted ? (
              <div
                className="rounded-xl border border-dashed border-[#e5e1df] bg-[#fafaf9] p-3 text-center text-xs text-[#57534e]"
                data-testid="inline-reply-restricted"
              >
                SMS reply unavailable for this restricted thread. Review the
                notice above before taking another safe action.
              </div>
            ) : replyRefreshPending ? (
              <div
                className="rounded-xl border border-dashed border-[#e5e1df] p-3 text-center text-xs text-[#78716c]"
                data-testid="inline-reply-refreshing"
              >
                Updating the thread phone before reply...
              </div>
            ) : data.homeownerContactId === data.contactId ? (
              <InlineReply
                key={`reply-${data.threadId}`}
                propertyId={data.propertyId}
                homeownerContactId={data.homeownerContactId}
                homeownerPhone={data.replyToPhone}
                replyToPhone={data.replyToPhone}
                phoneUnavailableMessage="This thread number is not saved on the homeowner contact — save or resolve it before replying."
              />
            ) : (
              <div
                className="rounded-xl border border-dashed border-[#e5e1df] p-3 text-center text-xs text-[#78716c]"
                data-testid="inline-reply-unavailable"
              >
                SMS replies from Messages are available only when this thread
                contact is the homeowner.
              </div>
            )}
          </div>
        </>
      ) : data.propertyId && isPermanentlyLocked ? null : (
        <div className="border-t border-border bg-white p-4">
          {data.contactId ? (
            <>
              <button
                type="button"
                onClick={() => setResolveOpen(true)}
                className="rounded-md border border-[#111827] bg-[#111827] px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-[#292524]"
                data-testid="resolve-to-property-open"
              >
                Resolve to property
              </button>
              <ResolveToPropertyDialog
                open={resolveOpen}
                onOpenChange={setResolveOpen}
                sourceConversationId={data.conversationId}
                contactId={data.contactId}
              />
            </>
          ) : (
            <span className="text-xs text-[#78716c]">
              This conversation has no contact linked.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function RestrictionNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-950 sm:px-6"
      role="status"
      data-testid="messages-contact-restriction"
    >
      {children}
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Detail-panel skeleton — shown while the URL thread param has changed
 * but the new server data hasn't landed yet. Mirrors the rough shape of
 * the loaded panel (header, message bubbles, dispo bar, composer) so the
 * transition feels structural rather than a "blank flash". Uses the
 * Tailwind `animate-pulse` utility for the breathing effect.
 */
function InboxDetailSkeleton({ onBackToList }: { onBackToList: () => void }) {
  return (
    <div
      className="bg-white border border-border rounded-xl flex h-full flex-col overflow-hidden"
      data-testid="inbox-detail-loading"
      aria-busy="true"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={onBackToList}
        className="mx-4 mt-2 inline-flex min-h-11 w-fit items-center gap-1 text-[12px] font-bold text-[#78716c] md:hidden"
        aria-label="All conversations"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        All conversations
      </button>
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
