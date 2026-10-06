import { formatPhoneDisplay } from "@/lib/phone-format";
import { useCallScreenLink, useCoachCall } from "./coach-call-context";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  CalendarCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  MapPin,
  Phone,
} from "lucide-react";

import { RepSmsComposer } from "../rep-sms-composer";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MyLeadDetailPanel } from "./detail-panel";
import { MyLeadSmsStrip } from "./sms-strip";
import {
  MY_LEAD_STAGE_LABELS,
  MY_LEAD_STAGE_ORDER,
  type MyLeadAction,
  type MyLeadDetailGroupName,
  type MyLeadDetailPageResult,
  type MyLeadDetailState,
  type MyLeadQueueRow,
  type MyLeadStage,
  type MyLeadWarning,
} from "./types";

const WARNING_LABELS: Record<MyLeadWarning, string> = {
  first_call_overdue: "First call overdue",
  missing_next_step: "No future next step",
  offer_needed_overdue: "Offer overdue",
  offer_follow_up_overdue: "Offer follow-up overdue",
};

const TEMPERATURE_CLASSES = {
  hot: "bg-red-600 dark:bg-red-500",
  warm: "bg-amber-600 dark:bg-amber-500",
  cold: "bg-blue-600 dark:bg-blue-500",
} as const;

export const STAGE_NEXT: Record<MyLeadStage, string> = {
  not_contacted: "Next: place a call or log an outreach attempt.",
  contacted:
    "Next: plan a callback, or mark ready when the seller is ready for an offer.",
  needs_offer: "Next: log the offer with a follow-up time.",
  offer_sent: "Next: follow up and record the offer outcome.",
  under_contract: "Signed contract recorded. Archive only when you choose.",
};

/** Row-detail "Needs:" helper copy — static per-stage wording, distinct from the
 * section-level STAGE_NEXT text (which other surfaces consume by name). */
const NEEDS_COPY: Record<MyLeadStage, React.ReactNode> = {
  not_contacted: (
    <>
      Needs:{" "}
      <span className="font-bold text-blue-700 dark:text-blue-300">
        first attempt logged
      </span>{" "}
      — moves to Contacted automatically.
    </>
  ),
  contacted: (
    <>
      Needs:{" "}
      <span className="font-bold text-teal-700 dark:text-teal-300">
        follow-up plan or offer decision
      </span>{" "}
      — mark ready when there&apos;s a reason to keep going.
    </>
  ),
  needs_offer: (
    <>
      Needs:{" "}
      <span className="font-bold text-amber-700 dark:text-amber-400">
        offer logged
      </span>{" "}
      (amount · date · how) — moves to Offer sent.
    </>
  ),
  offer_sent: (
    <>
      Needs:{" "}
      <span className="font-bold text-green-700 dark:text-green-400">
        contract signed
      </span>{" "}
      → Under contract ·{" "}
      <span className="font-bold text-red-700 dark:text-red-400">declined</span>{" "}
      → back to Contacted.
    </>
  ),
  under_contract: (
    <>
      Signed. <span className="font-bold text-foreground">Archive</span> when
      you&apos;re ready.
    </>
  ),
};

// Each lead card's border matches its section color (motivation still reads via
// the colored dot). A light full border + a stronger left accent tie the card to
// its stage bar.
const STAGE_CARD_BORDER: Record<MyLeadStage, string> = {
  not_contacted:
    "border-blue-200 border-l-blue-500 dark:border-blue-900 dark:border-l-blue-500",
  contacted:
    "border-teal-200 border-l-teal-600 dark:border-teal-900 dark:border-l-teal-500",
  needs_offer:
    "border-amber-200 border-l-amber-500 dark:border-amber-900 dark:border-l-amber-500",
  offer_sent:
    "border-violet-200 border-l-violet-500 dark:border-violet-900 dark:border-l-violet-500",
  under_contract:
    "border-green-200 border-l-green-600 dark:border-green-900 dark:border-l-green-500",
};

const ACTIONS_BY_STAGE: Record<
  MyLeadStage,
  readonly {
    action: MyLeadAction;
    label: string;
    primary?: boolean;
    danger?: boolean;
  }[]
> = {
  not_contacted: [
    { action: "start-call", label: "Start call", primary: true },
    { action: "log-attempt", label: "Log attempt" },
    { action: "contract-signed", label: "Contract signed" },
    { action: "handoff", label: "Handoff", danger: true },
  ],
  contacted: [
    {
      action: "ready-for-offer",
      label: "Ready to make an offer",
      primary: true,
    },
    { action: "start-call", label: "Start call" },
    { action: "log-attempt", label: "Log attempt" },
    { action: "log-offer", label: "Log offer" },
    { action: "contract-signed", label: "Contract signed" },
    { action: "schedule-next-step", label: "Schedule next step" },
    { action: "handoff", label: "Handoff", danger: true },
  ],
  needs_offer: [
    { action: "log-offer", label: "Log offer", primary: true },
    { action: "start-call", label: "Start call" },
    { action: "log-attempt", label: "Log attempt" },
    { action: "contract-signed", label: "Contract signed" },
    { action: "handoff", label: "Handoff", danger: true },
  ],
  offer_sent: [
    { action: "contract-signed", label: "Contract signed", primary: true },
    { action: "start-call", label: "Start call" },
    { action: "log-attempt", label: "Log attempt" },
    { action: "decline-offer", label: "Offer declined", danger: true },
    { action: "handoff", label: "Handoff", danger: true },
  ],
  under_contract: [{ action: "archive", label: "Archive", primary: true }],
};

export type MyLeadQueueRowProps = {
  row: MyLeadQueueRow;
  idSuffix?: string;
  sectionVisible?: boolean;
  /** Tags the lead the user arrived at from its lead page or Messages. */
  openedFromLead?: boolean;
  detailsOpen: boolean;
  detailState?: MyLeadDetailState;
  onToggleDetails: () => void;
  onRetryDetails: () => void;
  onDetailChanged?: () => void;
  onLoadDetailPage?: (
    group: MyLeadDetailGroupName,
    cursor: string | null,
  ) => Promise<MyLeadDetailPageResult>;
  onStageAction: (action: MyLeadAction, row: MyLeadQueueRow) => void;
};

export function MyLeadQueueRow({
  row,
  idSuffix = "",
  openedFromLead = false,
  detailsOpen,
  sectionVisible = true,
  detailState,
  onToggleDetails,
  onRetryDetails,
  onDetailChanged,
  onLoadDetailPage,
  onStageAction,
}: MyLeadQueueRowProps) {
  const domId = `${row.propertyId}${idSuffix}`;
  const coachCall = useCoachCall();
  const openCallScreen = useCallScreenLink();
  const temperature = row.motivation.temperature;
  const motivationLabel =
    row.motivation.motivationResponseKind === "provided"
      ? row.motivation.text || "Motivation provided"
      : row.motivation.motivationResponseKind === "no_motivation_provided"
        ? "No motivation provided"
        : "Motivation unanswered";

  const currentIndex = MY_LEAD_STAGE_ORDER.indexOf(row.queueStage);
  const actions = ACTIONS_BY_STAGE[row.queueStage];
  const primaryAction = actions.find((entry) => entry.primary) ?? actions[0];
  const secondaryActions = actions.filter((entry) => entry !== primaryAction);

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[14px] border border-l-[3px] bg-card text-card-foreground",
        STAGE_CARD_BORDER[row.queueStage],
      )}
      data-testid={`my-lead-row-${domId}`}
      data-lead-id={row.propertyId}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-3.5 px-4 py-3.5 text-left hover:bg-muted/30 outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
        aria-label={
          detailsOpen
            ? `Hide details for ${row.address}`
            : `Show details for ${row.address}`
        }
        aria-describedby={`my-lead-summary-${domId}`}
        aria-expanded={detailsOpen}
        aria-controls={`my-lead-detail-${domId}`}
        onClick={onToggleDetails}
      >
        <span
          className={cn(
            "size-[9px] shrink-0 rounded-full box-border",
            temperature
              ? TEMPERATURE_CLASSES[temperature]
              : "border-2 border-stone-300 dark:border-stone-600",
          )}
          title={
            temperature
              ? `${capitalize(temperature)} motivation`
              : motivationLabel
          }
          aria-label={
            temperature ? `${temperature} temperature` : motivationLabel
          }
        />
        <span
          id={`my-lead-summary-${domId}`}
          className="flex min-w-0 flex-1 flex-col gap-x-4 gap-y-2 xl:flex-row xl:items-center"
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="break-words text-[14.5px] font-bold">
              {row.homeownerName || "Homeowner unavailable"}
            </span>
            <span className="break-words text-[12.5px] text-muted-foreground">
              {row.address}
            </span>
            {row.queueStage === "not_contacted" && (
              <Badge
                variant="secondary"
                className="rounded-md border border-blue-200 bg-blue-100 px-[7px] py-[2px] text-[9.5px] font-extrabold tracking-wide text-blue-700 uppercase dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300"
              >
                New
              </Badge>
            )}
            {openedFromLead && (
              <Badge
                variant="secondary"
                className="border-teal-300 bg-teal-50 text-teal-900"
              >
                Opened from lead page
              </Badge>
            )}
            {row.archived && <Badge variant="secondary">Archived</Badge>}
            {row.dripReply && (
              <Badge
                variant="secondary"
                className="border-amber-300 bg-amber-50 text-amber-900"
              >
                Replied to drip
              </Badge>
            )}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] font-semibold text-muted-foreground">
            <span className="font-mono tabular-nums">
              {row.attemptsCount}{" "}
              {row.attemptsCount === 1 ? "attempt" : "attempts"}
            </span>
            {row.dripReply && (
              <span>
                Was in {row.dripReply.sequenceName} · stopped at text{" "}
                {row.dripReply.step} of {row.dripReply.totalSteps}
              </span>
            )}
            <span
              title={row.assignment.exactLabel}
              className="font-mono tabular-nums"
            >
              {row.assignment.state === "known"
                ? `assigned ${row.assignment.label}`
                : row.assignment.state === "launch_initialized"
                  ? "existing lead · assignment unknown"
                  : "assignment unavailable"}
            </span>
            {row.warningReasons.map((warning) => (
              <span
                key={warning}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#fecaca] bg-[#fee2e2] px-2.5 py-1 text-[11.5px] font-bold text-[#b91c1c] dark:border-red-900 dark:bg-red-950 dark:text-red-300"
              >
                <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                <span className="break-words">{WARNING_LABELS[warning]}</span>
              </span>
            ))}
            {row.queueStage === "contacted" && row.nextStep && (
              <span
                data-next-step-due-at={row.nextStep.dueAt}
                data-next-step-kind={row.nextStep.kind}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#bbf7d0] bg-[#dcfce7] px-2.5 py-1 text-[11.5px] font-bold text-[#15803d] dark:border-green-900 dark:bg-green-950 dark:text-green-300"
              >
                <CalendarCheck className="size-3 shrink-0" aria-hidden="true" />
                <span className="break-words">
                  {nextStepText(row.nextStep)}
                </span>
              </span>
            )}
            {row.queueStage === "needs_offer" &&
              !row.warningReasons.includes("offer_needed_overdue") && (
                <span className="rounded-full border border-[#fde68a] bg-[#fef3c7] px-2.5 py-1 text-[11.5px] font-bold text-[#b45309] dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                  Offer needed
                </span>
              )}
            {row.offer && (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#ddd6fe] bg-[#ede9fe] px-2.5 py-1 text-[11.5px] font-bold text-[#6d28d9] dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300">
                <Banknote className="size-3 shrink-0" aria-hidden="true" />
                <span className="break-words">
                  {row.offer.amountLabel} · {capitalize(row.offer.outcome)}
                </span>
              </span>
            )}
          </span>
        </span>
        {detailsOpen ? (
          <ChevronDown
            className="size-4 shrink-0 text-[#a8a29e]"
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className="size-4 shrink-0 text-[#a8a29e]"
            aria-hidden="true"
          />
        )}
      </button>

      <div id={`my-lead-detail-${domId}`} hidden={!detailsOpen}>
        {/* Retain loaded detail state through collapse without mounting unopened details. */}
        {(detailsOpen || detailState?.status === "ready") && (
          <>
            <div className="border-t border-[#f0eeec] pl-[33px] pr-[18px] pt-2 pb-[18px] dark:border-border">
              <p className="flex items-center gap-2 pt-2 text-sm text-muted-foreground">
                <Phone className="size-3.5" aria-hidden="true" />
                {formatPhoneDisplay(row.phone) || "Phone unavailable"}
              </p>

              <div className="flex flex-wrap gap-2 pt-4">
                <span
                  className={cn(
                    "inline-flex items-center gap-[7px] rounded-[9px] border px-3 py-[7px] text-xs font-semibold",
                    row.firstCall.state === "started"
                      ? "border-[#bbf7d0] bg-[#dcfce7] text-[#15803d] dark:border-green-900 dark:bg-green-950 dark:text-green-300"
                      : "border-[#e5e1df] bg-[#faf9f7] text-muted-foreground dark:border-border dark:bg-muted/30",
                  )}
                  title={row.firstCall.exactLabel}
                >
                  <Clock className="size-3.5" aria-hidden="true" />
                  {row.firstCall.label || firstCallLabel(row.firstCall.state)}
                </span>
                <span
                  className="inline-flex items-center gap-[7px] rounded-[9px] border border-[#e5e1df] bg-[#faf9f7] px-3 py-[7px] text-xs font-semibold text-muted-foreground dark:border-border dark:bg-muted/30"
                  title={row.assignment.exactLabel}
                >
                  <MapPin className="size-3.5" aria-hidden="true" />
                  {row.assignment.state === "known"
                    ? `assigned ${row.assignment.label}`
                    : row.assignment.state === "launch_initialized"
                      ? "existing lead · assignment unknown"
                      : "assignment unavailable"}
                </span>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-1 pt-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  {temperature && (
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        TEMPERATURE_CLASSES[temperature],
                      )}
                      aria-hidden="true"
                    />
                  )}
                  <span className="font-semibold text-foreground">
                    Motivation:
                  </span>{" "}
                  {motivationLabel}
                </span>
                {row.nextStep && (
                  <span
                    data-next-step-due-at={row.nextStep.dueAt}
                    data-next-step-kind={row.nextStep.kind}
                  >
                    <span className="font-semibold text-foreground">
                      Next step:
                    </span>{" "}
                    {nextStepText(row.nextStep)}
                  </span>
                )}
                {row.stripReason && (
                  <span data-testid={`strip-reason-${row.propertyId}`}>
                    <span className="font-semibold text-foreground">
                      In Call next:
                    </span>{" "}
                    {row.stripReason}
                  </span>
                )}
              </div>

              <MyLeadSmsStrip
                state={detailState ?? { status: "loading" }}
                onRetry={onRetryDetails}
                onLoadDetailPage={onLoadDetailPage}
              />

              <div className="pt-4">
                <p className="mb-[9px] text-[10px] font-extrabold tracking-[0.08em] text-muted-foreground uppercase">
                  Where it is
                </p>
                <ol
                  aria-label="Lead progress"
                  className="flex flex-wrap items-center text-[11px] font-bold"
                >
                  {MY_LEAD_STAGE_ORDER.map((stage, index) => {
                    const status =
                      index < currentIndex
                        ? "done"
                        : index === currentIndex
                          ? "cur"
                          : index === currentIndex + 1
                            ? "next"
                            : "upcoming";
                    return (
                      <li key={stage} className="flex items-center">
                        <span
                          aria-current={
                            stage === row.queueStage ? "step" : undefined
                          }
                          className={cn(
                            "flex items-center gap-[7px]",
                            index > 0 && "ml-0",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "size-[11px] shrink-0 rounded-full border-2 box-border",
                              status === "done" &&
                                "border-[#a8a29e] bg-[#a8a29e]",
                              status === "cur" &&
                                "border-blue-600 bg-blue-600 ring-[3px] ring-blue-600/20",
                              status === "next" &&
                                "border-dashed border-blue-300",
                              status === "upcoming" &&
                                "border-stone-300 dark:border-stone-600",
                            )}
                          />
                          <span
                            className={cn(
                              "whitespace-nowrap",
                              status === "done" && "text-muted-foreground",
                              status === "cur" && "text-foreground",
                              status === "next" &&
                                "text-blue-700 dark:text-blue-400",
                              status === "upcoming" && "text-muted-foreground",
                            )}
                          >
                            {MY_LEAD_STAGE_LABELS[stage]}
                          </span>
                        </span>
                        {index < MY_LEAD_STAGE_ORDER.length - 1 && (
                          <span
                            className={cn(
                              "mx-[7px] h-[2px] w-5 shrink-0",
                              status === "done"
                                ? "bg-[#a8a29e]"
                                : "bg-[#e5e1df] dark:bg-border",
                            )}
                          />
                        )}
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-2.5 text-xs font-medium text-muted-foreground">
                  {NEEDS_COPY[row.queueStage]}
                </p>
              </div>

              {row.offer && (
                <div className="mt-4 inline-grid grid-cols-3 gap-5 rounded-xl border border-[#e5e1df] bg-[#faf9f7] px-4 py-3 text-xs dark:border-border dark:bg-muted/30">
                  <div>
                    <div className="mb-[3px] text-[10px] font-extrabold tracking-[0.06em] text-muted-foreground uppercase">
                      Amount
                    </div>
                    <div className="font-mono text-[13px] font-bold">
                      {row.offer.amountLabel}
                    </div>
                  </div>
                  <div>
                    <div className="mb-[3px] text-[10px] font-extrabold tracking-[0.06em] text-muted-foreground uppercase">
                      Sent
                    </div>
                    <div className="font-mono text-[13px] font-bold">
                      {row.offer.method} · {row.offer.sentLabel}
                    </div>
                  </div>
                  <div>
                    <div className="mb-[3px] text-[10px] font-extrabold tracking-[0.06em] text-muted-foreground uppercase">
                      Status
                    </div>
                    <div className="font-mono text-[13px] font-bold">
                      {row.offer.followUpLabel
                        ? `Follow-up ${row.offer.followUpLabel}`
                        : capitalize(row.offer.outcome)}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <MyLeadDetailPanel
              visible={detailsOpen && sectionVisible}
              state={detailState ?? { status: "loading" }}
              onRetry={onRetryDetails}
              propertyId={row.propertyId}
              onChanged={onDetailChanged ? () => onDetailChanged() : undefined}
              onLoadDetailPage={onLoadDetailPage}
            />

            <div
              data-testid={`my-lead-actions-${domId}`}
              role="group"
              aria-label="Lead actions"
              className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-t border-[#f0eeec] px-4 py-4 dark:border-border"
            >
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  onStageAction(primaryAction.action, row);
                }}
              >
                <ArrowRight className="size-[15px]" aria-hidden="true" />
                {primaryAction.label}
              </Button>
              <a
                href={`/leads/${row.propertyId}`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Open lead
              </a>
              {row.zillowHref && (
                <a
                  href={row.zillowHref}
                  onClick={openActionWindow}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({
                    variant: "outline",
                    size: "sm",
                    className:
                      "border-[#bfdbfe] text-[#1d4ed8] dark:border-blue-900 dark:text-blue-300",
                  })}
                >
                  <ExternalLink aria-hidden="true" /> Open in Zillow
                </a>
              )}
              <RepSmsComposer
                propertyId={row.propertyId}
                placement="action"
                onSent={() => {
                  onRetryDetails();
                  onDetailChanged?.();
                }}
              />
              {openCallScreen && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-[#e5e1df] bg-background text-muted-foreground hover:text-foreground dark:border-border"
                  data-testid={`queue-row-open-call-screen-${row.propertyId}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openCallScreen(row.propertyId);
                  }}
                >
                  Open call screen
                </Button>
              )}
              {coachCall && actions.some((item) => item.action === "start-call") && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={coachCall.disabled}
                  className="border-[#e5e1df] bg-background text-muted-foreground hover:text-foreground dark:border-border"
                  data-testid={`queue-row-call-with-coach-${row.propertyId}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    coachCall.call(row.propertyId);
                  }}
                >
                  <Phone className="size-[13px]" aria-hidden="true" />
                  Call with coach
                </Button>
              )}
              {secondaryActions.map(({ action, label, danger }) => (
                <Button
                  key={action}
                  type="button"
                  variant={danger ? "destructive" : "outline"}
                  size="sm"
                  className={cn(
                    !danger &&
                      "border-[#e5e1df] bg-background text-muted-foreground hover:text-foreground dark:border-border",
                    danger && "ml-auto",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onStageAction(action, row);
                  }}
                >
                  {action === "start-call" && (
                    <Phone className="size-[13px]" aria-hidden="true" />
                  )}
                  {label}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function nextStepText(step: NonNullable<MyLeadQueueRow["nextStep"]>) {
  if (step.kind === "callback") return `Callback · ${step.label}`
  return `${step.mode === "in_person" ? "In person" : "Phone appointment"} · ${step.label}`
}

function firstCallLabel(state: MyLeadQueueRow["firstCall"]["state"]) {
  switch (state) {
    case "started":
      return "First call started";
    case "unavailable":
      return "First-call timing unavailable";
    default:
      return "First call pending";
  }
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function openActionWindow(event: React.MouseEvent<HTMLAnchorElement>) {
  event.stopPropagation();
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.open(event.currentTarget.href, "_blank", "popup,width=1200,height=900,noopener,noreferrer");
}
