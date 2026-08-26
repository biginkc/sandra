"use client";

import { Loader2Icon, MicIcon, MicOffIcon, PauseIcon, PhoneOffIcon, PlayIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PhoneKeypad } from "@/components/softphone/phone-keypad";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DtmfDigit } from "@/lib/dialer/transport";
import {
  buildPhaseScriptBlock,
  CLOSR_SCRIPT,
  getScriptObjection,
  getScriptPhase,
  nextPhaseId,
  resolveObjectionOvercome,
  type BranchSelectContext,
  type PhaseScriptBlock,
  type ScriptBranchBlock,
} from "@/lib/coach/script-block";
import { resolveCoachTokens, resolveDisplayText } from "@/lib/coach/token-resolver";
import type {
  CoachCallContext,
  CoachEntryToken,
  CoachHoldTimer,
  CoachNudge,
  CoachObjectionCard,
  CoachPhaseId,
  CoachToken,
  CoachTranscriptLine,
  ResolvedToken,
  ResolvedTokens,
} from "@/lib/coach/types";
import { COACH_ENTRY_TOKENS, COACH_PHASE_ORDER } from "@/lib/coach/types";
import type { CoachSession, ContextLoadState } from "@/lib/coach/use-coach-session";
import { isNearTranscriptBottom } from "@/lib/coach/transcript-scroll";
import { cn } from "@/lib/utils";

export type CoachCallStatus = "connecting" | "ringing" | "live" | "ended" | "failed" | null;

export type CoachLiveViewProps = {
  /** The persistent coach session — owned by the provider, not this view,
   * so collapsing/reopening the view never resets it. */
  session: CoachSession;
  callName: string;
  callStatus: CoachCallStatus;
  seconds: number;
  muted: boolean;
  held: boolean;
  holdPending: boolean;
  onDigit: (digit: DtmfDigit) => void;
  onMute: () => void;
  onHold: () => void;
  onHangup: () => void;
  /** Shrinks back to the classic call popover — Esc does the same. The
   * popover surfaces an "Open live coach" button to reverse this. The
   * coach session itself (transcript, phase, gates, cards, entered
   * values) lives in the provider and is unaffected by this. */
  onCollapse: () => void;
};

const EMPTY_CALL_CONTEXT: CoachCallContext = {
  sellerName: null,
  propertyAddress: null,
  propertyCounty: null,
  repName: null,
  repPhoneE164: null,
  motivation: null,
  leadId: null,
  sellerPhoneE164: null,
  coldCallerName: null,
  yearBuilt: null,
  leadSource: null,
  occupancy: null,
};

const ENTRY_TOKEN_SET: ReadonlySet<string> = new Set(COACH_ENTRY_TOKENS);

const ENTRY_TOKEN_LABEL: Record<CoachEntryToken, string> = {
  closing_date: "closing date",
  offer_price: "offer price",
  net_to_seller: "net to seller",
};

const MAX_RENDERED_TRANSCRIPT_LINES = 200;

function timerText(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function CoachLiveView(props: CoachLiveViewProps) {
  const { session, callName, callStatus, seconds, muted, held, holdPending, onDigit, onMute, onHold, onHangup, onCollapse } = props;
  const {
    state,
    dispatch,
    degraded,
    reconnectGap,
    dismissReconnectGap,
    scriptOutOfSync,
    contextLoad,
    retryContext,
    branchOverrides,
    selectVariant,
    setEntryField,
  } = session;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCollapse]);

  // The script must always render, even mid-load or after a failed context
  // fetch — a static, all-placeholder script is still useful, and never an
  // infinite spinner.
  const activeContext = contextLoad.status === "ready" ? contextLoad.context : EMPTY_CALL_CONTEXT;
  const tokens: ResolvedTokens = useMemo(
    () => resolveCoachTokens(activeContext, state.entryFields),
    [activeContext, state.entryFields],
  );
  const selectCtx: BranchSelectContext = useMemo(
    () => ({ leadSource: activeContext.leadSource, occupancy: activeContext.occupancy }),
    [activeContext.leadSource, activeContext.occupancy],
  );

  const displayedPhaseId = state.overriddenPhaseId ?? state.currentPhaseId;
  const scriptBlock = buildPhaseScriptBlock(displayedPhaseId, tokens, selectCtx, branchOverrides);
  const upcomingId = nextPhaseId(displayedPhaseId);
  const nextBlock = upcomingId ? buildPhaseScriptBlock(upcomingId, tokens, selectCtx, branchOverrides) : null;
  const gateEntries = (scriptBlock?.gates ?? []).map((gate) => ({
    ...gate,
    cleared: state.gates[gate.id] ?? false,
  }));

  const onEditEntry = useCallback(
    (field: CoachEntryToken, value: string) => setEntryField(field, value),
    [setEntryField],
  );
  const onSelectVariant = useCallback((tag: string, key: string) => selectVariant(tag, key), [selectVariant]);

  return (
    <div
      role="dialog"
      aria-label="Live call coach"
      aria-modal="true"
      data-testid="coach-live-view"
      className="fixed inset-0 z-[80] flex flex-col bg-background text-foreground"
    >
      <CoachTopBar
        currentPhaseId={state.currentPhaseId}
        displayedPhaseId={displayedPhaseId}
        onSelectPhase={(phaseId) => {
          // Local display jump only — logged for now, not sent to the server.
          console.info("[coach] manual phase override", { phaseId });
          dispatch({ type: "override_phase", phaseId });
        }}
        counter={scriptBlock?.counter ?? null}
        probeCount={state.probeCount}
        holdTimer={state.holdTimer}
        gates={gateEntries}
        degraded={degraded}
        callStatus={callStatus}
      />
      {scriptOutOfSync ? (
        <div
          role="alert"
          data-testid="coach-version-mismatch"
          className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
        >
          <span>
            Coach out of sync — the live coach is running script {scriptOutOfSync}, this view is on {CLOSR_SCRIPT.version}.
            Script lines below may not match what the coach is tracking.
          </span>
        </div>
      ) : null}
      {reconnectGap ? (
        <div
          role="status"
          data-testid="coach-reconnect-gap"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900"
        >
          <span>Reconnected — some coach events may have been missed while disconnected.</span>
          <button type="button" data-testid="dismiss-reconnect-gap" onClick={dismissReconnectGap} className="font-bold underline">
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <TranscriptFeed lines={state.transcript} />
        <ScriptPanel
          block={scriptBlock}
          nextBlock={nextBlock}
          degraded={degraded}
          contextLoad={contextLoad}
          onRetryContext={retryContext}
          onEditEntry={onEditEntry}
          onSelectVariant={onSelectVariant}
        />
      </div>
      <NudgeOverlay
        nudges={state.nudges}
        onDismiss={(nudgeId) => dispatch({ type: "dismiss_nudge", nudgeId })}
      />
      <ObjectionOverlay
        cards={state.objectionCards}
        tokens={tokens}
        occupancy={activeContext.occupancy}
        onDismiss={(cardId) => dispatch({ type: "dismiss_objection", cardId })}
      />
      <CallControlDock
        callName={callName}
        callStatus={callStatus}
        seconds={seconds}
        muted={muted}
        held={held}
        holdPending={holdPending}
        onDigit={onDigit}
        onMute={onMute}
        onHold={onHold}
        onHangup={onHangup}
        onCollapse={onCollapse}
      />
    </div>
  );
}

function CoachTopBar({
  currentPhaseId,
  displayedPhaseId,
  onSelectPhase,
  counter,
  probeCount,
  holdTimer,
  gates,
  degraded,
  callStatus,
}: {
  currentPhaseId: CoachPhaseId;
  displayedPhaseId: CoachPhaseId;
  onSelectPhase: (phaseId: CoachPhaseId) => void;
  counter: { label: string; goal: number } | null;
  probeCount: number;
  holdTimer: CoachHoldTimer | null;
  gates: { id: string; display: string; cleared: boolean }[];
  degraded: boolean;
  callStatus: CoachCallStatus;
}) {
  const preConnectLabel = callStatus === "connecting" ? "Connecting…" : callStatus === "ringing" ? "Ringing…" : null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
      <ol className="flex flex-1 flex-wrap items-center gap-1.5" aria-label="Call phases">
        {COACH_PHASE_ORDER.map((phaseId) => {
          const phase = getScriptPhase(phaseId);
          const isCurrent = phaseId === currentPhaseId;
          const isDisplayed = phaseId === displayedPhaseId;
          return (
            <li key={phaseId}>
              <button
                type="button"
                data-testid={`phase-rail-${phaseId}`}
                aria-current={isDisplayed ? "step" : undefined}
                onClick={() => onSelectPhase(phaseId)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-bold transition-colors",
                  isCurrent
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : isDisplayed
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                {phase?.name ?? phaseId}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        {preConnectLabel ? (
          <Badge variant="outline" data-testid="call-status-pill" className="text-muted-foreground">
            {preConnectLabel}
          </Badge>
        ) : null}
        {degraded ? (
          <Badge variant="outline" data-testid="coach-connecting-pill" className="text-muted-foreground">
            Coach connecting…
          </Badge>
        ) : null}
        {counter ? (
          <Badge variant="secondary" data-testid="probe-counter">
            {`Probes ${probeCount}/${counter.goal}`}
          </Badge>
        ) : null}
        {holdTimer ? <HoldTimerChip timer={holdTimer} /> : null}
        {gates.map((gate) => (
          <Badge
            key={gate.id}
            data-testid={`gate-${gate.id}`}
            variant={gate.cleared ? "secondary" : "destructive"}
          >
            {gate.cleared ? "Concerns cleared" : gate.display}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function HoldTimerChip({ timer }: { timer: CoachHoldTimer }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - new Date(timer.startedAt).getTime()) / 1000));
  const remaining = Math.max(0, timer.durationS - elapsed);
  return (
    <Badge variant={remaining <= 30 ? "destructive" : "outline"} data-testid="hold-timer">
      {`Hold ${timerText(remaining)}`}
    </Badge>
  );
}

function TranscriptFeed({ lines }: { lines: CoachTranscriptLine[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      wasAtBottomRef.current = isNearTranscriptBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !wasAtBottomRef.current) return;
    el.scrollTo?.({ top: el.scrollHeight });
  }, [lines]);

  const visibleLines = lines.length > MAX_RENDERED_TRANSCRIPT_LINES
    ? lines.slice(lines.length - MAX_RENDERED_TRANSCRIPT_LINES)
    : lines;

  return (
    <aside
      aria-label="Live transcript"
      className="hidden w-full max-w-xs shrink-0 flex-col overflow-hidden border-r border-border bg-muted/30 md:flex"
    >
      <div className="border-b border-border px-4 py-2.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">
        Transcript
      </div>
      <div ref={containerRef} data-testid="coach-transcript" className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {visibleLines.length === 0 ? (
          <p className="text-xs text-muted-foreground">Waiting for the call to start talking…</p>
        ) : null}
        {visibleLines.map((line) => (
          <p
            key={line.id}
            data-testid="transcript-line"
            data-final={line.isFinal}
            className={cn(
              "text-sm leading-snug",
              line.speaker === "rep" ? "text-foreground" : "text-primary",
              !line.isFinal && "text-muted-foreground italic",
            )}
          >
            <span className="mr-1.5 text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
              {line.speaker === "rep" ? "Rep" : "Seller"}
            </span>
            {line.text}
          </p>
        ))}
      </div>
    </aside>
  );
}

function ScriptPanel({
  block,
  nextBlock,
  degraded,
  contextLoad,
  onRetryContext,
  onEditEntry,
  onSelectVariant,
}: {
  block: PhaseScriptBlock | null;
  nextBlock: PhaseScriptBlock | null;
  degraded: boolean;
  contextLoad: ContextLoadState;
  onRetryContext: () => void;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
  onSelectVariant: (tag: string, key: string) => void;
}) {
  if (!block) {
    // Only reachable for a genuinely unknown/corrupt phase id slipping past
    // event validation — not for a load-in-progress or failed context,
    // which resolve against an all-placeholder context instead. A spinner
    // here would imply something is still loading, which is false: nothing
    // will ever resolve this. Say so plainly instead of wedging silently.
    return (
      <main className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="max-w-sm text-center">
          <Loader2Icon className="mx-auto mb-3 size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-semibold text-destructive">This call phase isn&apos;t recognized.</p>
          <p className="mt-1 text-xs text-muted-foreground">Use the phase rail above to jump to a known phase.</p>
        </div>
      </main>
    );
  }
  return (
    <main className="flex-1 overflow-y-auto p-6 md:p-10" data-testid="coach-script-panel">
      <div className="mx-auto max-w-2xl">
        <div className="mb-1 text-xs font-bold tracking-wide text-muted-foreground uppercase">
          {block.phaseName}
        </div>
        <p className="mb-4 text-sm text-muted-foreground italic">{block.purpose}</p>
        {contextLoad.status === "error" ? (
          <div
            role="alert"
            data-testid="coach-context-error"
            className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <span>Couldn&apos;t load lead details — showing the script with placeholders.</span>
            <Button type="button" variant="outline" size="xs" data-testid="coach-context-retry" onClick={onRetryContext}>
              Retry
            </Button>
          </div>
        ) : null}
        {degraded ? (
          <p className="mb-4 text-xs text-muted-foreground" data-testid="coach-degraded-note">
            Live coaching hasn&apos;t connected yet — here&apos;s the full script, scroll manually.
          </p>
        ) : null}
        {block.openingCues.length > 0 ? (
          <div className="mb-4 flex flex-wrap gap-1.5">
            {block.openingCues.map((cue, index) => (
              <ToneChip key={index} text={cue} />
            ))}
          </div>
        ) : null}
        <div className="space-y-4">
          {block.branches.map((branch) => (
            <BranchCard
              key={branch.tag}
              branch={branch}
              onEditEntry={onEditEntry}
              onSelectVariant={(key) => onSelectVariant(branch.tag, key)}
            />
          ))}
        </div>
        {block.situationalCues.length > 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-border p-3">
            <div className="mb-1.5 text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
              If this happens…
            </div>
            <ul className="space-y-1">
              {block.situationalCues.map((cue) => (
                <li key={cue.trigger} className="text-xs text-muted-foreground">
                  {cue.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {nextBlock ? (
          <div className="mt-8 opacity-45" data-testid="next-phase-preview">
            <div className="mb-1 text-xs font-bold tracking-wide text-muted-foreground uppercase">
              Next: {nextBlock.phaseName}
            </div>
            <p className="text-sm">
              {nextBlock.branches[0]?.selected.lines[0]?.segments
                .map((segment) => (segment.kind === "tone" ? "" : segment.kind === "text" ? segment.value : segment.resolved.value))
                .join("")}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function BranchCard({
  branch,
  onEditEntry,
  onSelectVariant,
}: {
  branch: ScriptBranchBlock;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
  onSelectVariant: (key: string) => void;
}) {
  return (
    <div
      data-testid="script-branch"
      className={cn(
        "rounded-xl border px-4 py-3",
        branch.critical ? "border-2 border-primary bg-primary/5" : "border-border bg-card",
      )}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold tracking-wide text-muted-foreground uppercase">{branch.tag}</span>
          {branch.autoSelected ? (
            <Badge variant="outline" className="text-[10px]">
              auto
            </Badge>
          ) : null}
        </div>
        {branch.variantOptions.length > 1 ? (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label={`${branch.tag} variant`}>
            {branch.variantOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={option.key === branch.selected.key}
                data-testid={`variant-${branch.tag}-${option.key}`}
                onClick={() => onSelectVariant(option.key)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-bold",
                  option.key === branch.selected.key
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {option.label ?? option.key}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {branch.selected.tone ? (
        <div className="mb-2">
          <ToneChip text={branch.selected.tone} />
        </div>
      ) : null}
      <div className="space-y-2">
        {branch.selected.lines.map((line, index) => (
          <p
            key={index}
            className={cn(
              "text-[15px] leading-relaxed",
              line.type === "note" && "text-xs text-muted-foreground italic",
            )}
          >
            {line.segments.map((segment, segIndex) => {
              if (segment.kind === "text") return <span key={segIndex}>{segment.value}</span>;
              if (segment.kind === "tone") return <ToneChip key={segIndex} text={segment.label} />;
              return <TokenChip key={segIndex} token={segment.token} resolved={segment.resolved} onEditEntry={onEditEntry} />;
            })}
          </p>
        ))}
      </div>
      {branch.trailingNote ? (
        <p className="mt-2 text-xs text-muted-foreground italic">
          {branch.trailingNote.map((segment, index) =>
            segment.kind === "text" ? (
              <span key={index}>{segment.value}</span>
            ) : segment.kind === "tone" ? (
              <ToneChip key={index} text={segment.label} />
            ) : (
              <TokenChip key={index} token={segment.token} resolved={segment.resolved} onEditEntry={onEditEntry} />
            ),
          )}
        </p>
      ) : null}
      {branch.holdAfter ? (
        <div className="mt-3 rounded-lg bg-muted px-3 py-1.5 text-center text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
          {branch.holdAfter}
        </div>
      ) : null}
    </div>
  );
}

function ToneChip({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
      {text}
    </span>
  );
}

function TokenChip({
  token,
  resolved,
  onEditEntry,
}: {
  token: CoachToken;
  resolved: ResolvedToken;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
}) {
  if (ENTRY_TOKEN_SET.has(token)) {
    return <EntryTokenChip token={token as CoachEntryToken} resolved={resolved} onCommit={(value) => onEditEntry(token as CoachEntryToken, value)} />;
  }
  if (resolved.isPlaceholder) {
    return (
      <span
        data-testid="token-placeholder"
        className="mx-0.5 inline-flex items-center rounded-full border border-dashed border-muted-foreground/40 bg-muted px-1.5 py-0 text-[11px] text-muted-foreground"
      >
        missing
      </span>
    );
  }
  return <span className="font-semibold">{resolved.value}</span>;
}

function EntryTokenChip({
  token,
  resolved,
  onCommit,
}: {
  token: CoachEntryToken;
  resolved: ResolvedToken;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(resolved.isPlaceholder ? "" : resolved.value);

  if (editing) {
    return (
      <input
        autoFocus
        data-testid={`entry-input-${token}`}
        aria-label={ENTRY_TOKEN_LABEL[token]}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          onCommit(draft);
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onCommit(draft);
            setEditing(false);
          }
          if (event.key === "Escape") setEditing(false);
        }}
        className="mx-0.5 inline-block w-28 rounded border border-primary bg-background px-1.5 py-0 text-[12px] outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      data-testid={`entry-chip-${token}`}
      onClick={() => {
        setDraft(resolved.isPlaceholder ? "" : resolved.value);
        setEditing(true);
      }}
      className={cn(
        "mx-0.5 inline-flex items-center rounded-full border px-1.5 py-0 text-[11px] font-semibold",
        resolved.isPlaceholder
          ? "border-dashed border-primary/50 text-primary"
          : "border-primary/40 bg-primary/10 text-primary",
      )}
    >
      {resolved.isPlaceholder ? `+ ${ENTRY_TOKEN_LABEL[token]}` : resolved.value}
    </button>
  );
}

/** Coaching nudges (phase-entry rules, pain-word prompts) the producer
 * pushes live via coach_note events — same transient-guidance treatment as
 * objection cards (slide in, own auto-dismiss timer, tap to dismiss, never
 * modal), rendered in their own top-left area so they never collide with
 * objection cards at top-right. */
function NudgeOverlay({
  nudges,
  onDismiss,
}: {
  nudges: CoachNudge[];
  onDismiss: (nudgeId: string) => void;
}) {
  if (nudges.length === 0) return null;
  return (
    <div className="pointer-events-none fixed top-20 left-4 z-[90] flex w-[min(320px,calc(100vw-32px))] flex-col gap-2">
      {nudges.map((nudge) => (
        <NudgeCard key={nudge.id} nudge={nudge} onDismiss={() => onDismiss(nudge.id)} />
      ))}
    </div>
  );
}

/** Owns its own auto-dismiss timer, scoped to this nudge's mount lifetime —
 * a sibling nudge appearing or disappearing never resets or cancels it
 * (same pattern as ObjectionCard). The timer's duration is computed from
 * `nudge.expiresAt` (set once, at insert time, in event-reducer.ts) rather
 * than a fixed TTL, so a remount — collapsing and reopening the coach view
 * unmounts every card — picks up the correctly-shrunk remaining time
 * instead of restarting the full duration. */
function NudgeCard({ nudge, onDismiss }: { nudge: CoachNudge; onDismiss: () => void }) {
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    const remaining = Math.max(0, nudge.expiresAt - Date.now());
    const timer = setTimeout(() => onDismissRef.current(), remaining);
    return () => clearTimeout(timer);
    // Intentionally mount-once — same pattern as ObjectionCard. expiresAt
    // itself never changes after insert, so there's nothing to re-derive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <button
      type="button"
      data-testid="coach-nudge"
      onClick={onDismiss}
      className="animate-in slide-in-from-left-4 pointer-events-auto rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-left text-sm text-amber-900 shadow-lg"
    >
      {nudge.text}
    </button>
  );
}

function ObjectionOverlay({
  cards,
  tokens,
  occupancy,
  onDismiss,
}: {
  cards: CoachObjectionCard[];
  tokens: ResolvedTokens;
  occupancy: CoachCallContext["occupancy"];
  onDismiss: (cardId: string) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="pointer-events-none fixed top-20 right-4 z-[90] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2">
      {cards.map((card) => (
        <ObjectionCard key={card.id} card={card} tokens={tokens} occupancy={occupancy} onDismiss={() => onDismiss(card.id)} />
      ))}
    </div>
  );
}

function ObjectionLine({ label, text, tokens }: { label: string; text: string; tokens: ResolvedTokens }) {
  const segments = resolveDisplayText(text, tokens);
  return (
    <p>
      <span className="font-bold">{label} — </span>
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <span key={index}>{segment.value}</span>;
        if (segment.kind === "tone") return <ToneChip key={index} text={segment.label} />;
        // Objection text never contains the 3 rep-entry tokens today, but
        // fall back to plain-value rendering (no inline editor here) if
        // the script ever adds one — the card is transient, not the right
        // place to capture a deal value.
        return <span key={index} className="font-semibold">{segment.resolved.value}</span>;
      })}
    </p>
  );
}

/** Owns its own auto-dismiss timer, scoped to this card's mount lifetime —
 * a sibling card appearing or disappearing never resets or cancels it. The
 * timer's duration is computed from `card.expiresAt` (set once, at insert
 * time, in event-reducer.ts) rather than a fixed TTL, so a remount —
 * collapsing and reopening the coach view unmounts every card — picks up
 * the correctly-shrunk remaining time instead of restarting the full 45s. */
function ObjectionCard({
  card,
  tokens,
  occupancy,
  onDismiss,
}: {
  card: CoachObjectionCard;
  tokens: ResolvedTokens;
  occupancy: CoachCallContext["occupancy"];
  onDismiss: () => void;
}) {
  const onDismissRef = useRef(onDismiss);
  // Keeps the ref current after every render — refs must not be written
  // during render itself, only in an effect or event handler.
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    const remaining = Math.max(0, card.expiresAt - Date.now());
    const timer = setTimeout(() => onDismissRef.current(), remaining);
    return () => clearTimeout(timer);
    // Intentionally mount-once: this card's lifetime timer must not be
    // rearmed or cleared by anything other than its own unmount/dismiss.
    // expiresAt never changes after insert, so there's nothing to re-derive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const objection = getScriptObjection(card.objectionId);
  const overcomeText = objection ? resolveObjectionOvercome(objection, occupancy) : null;
  return (
    <button
      type="button"
      data-testid="objection-card"
      onClick={onDismiss}
      className="animate-in slide-in-from-right-4 pointer-events-auto rounded-2xl border border-border bg-card p-3.5 text-left shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Objection</span>
        {objection?.display.tonality ? <ToneChip text={objection.display.tonality} /> : null}
      </div>
      {objection && overcomeText ? (
        <div className="space-y-1.5 text-sm">
          <ObjectionLine label="Acknowledge" text={objection.display.acknowledge} tokens={tokens} />
          <ObjectionLine label="Disarm" text={objection.display.disarm} tokens={tokens} />
          <ObjectionLine label="Overcome" text={overcomeText} tokens={tokens} />
          {objection.display.template ? (
            <p className="rounded-lg border border-dashed border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              {objection.display.template_note ?? "Live worked example — substitute the seller's real numbers."}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{card.objectionId}</p>
      )}
    </button>
  );
}

function CallControlDock({
  callName,
  callStatus,
  seconds,
  muted,
  held,
  holdPending,
  onDigit,
  onMute,
  onHold,
  onHangup,
  onCollapse,
}: {
  callName: string;
  callStatus: CoachCallStatus;
  seconds: number;
  muted: boolean;
  held: boolean;
  holdPending: boolean;
  onDigit: (digit: DtmfDigit) => void;
  onMute: () => void;
  onHold: () => void;
  onHangup: () => void;
  onCollapse: () => void;
}) {
  const [keypadOpen, setKeypadOpen] = useState(false);
  const live = callStatus === "live";
  const timerLabel = held
    ? "On hold"
    : callStatus === "connecting"
      ? "Connecting…"
      : callStatus === "ringing"
        ? "Ringing…"
        : timerText(seconds);

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-card px-4 py-3">
      {keypadOpen ? <PhoneKeypad onDigit={onDigit} disabled={held || holdPending || !live} /> : null}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Collapse to popover"
            data-testid="coach-collapse"
            onClick={onCollapse}
          >
            <XIcon className="size-4" aria-hidden />
          </Button>
          <div>
            <div className="text-sm font-bold">{callName}</div>
            <div
              className={cn("font-mono text-xs", live || held ? "text-muted-foreground" : "text-blue-700")}
              data-testid="coach-call-timer"
            >
              {timerLabel}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={muted ? "default" : "outline"}
            size="sm"
            aria-pressed={muted}
            data-testid="coach-mute"
            onClick={onMute}
          >
            {muted ? <MicOffIcon className="size-4" aria-hidden /> : <MicIcon className="size-4" aria-hidden />}
            {muted ? "Unmute" : "Mute"}
          </Button>
          <Button
            type="button"
            variant={keypadOpen ? "default" : "outline"}
            size="sm"
            aria-expanded={keypadOpen}
            disabled={held || holdPending || !live}
            data-testid="coach-keypad-toggle"
            onClick={() => setKeypadOpen((value) => !value)}
          >
            Keypad
          </Button>
          <Button
            type="button"
            variant={held ? "default" : "outline"}
            size="sm"
            aria-pressed={held}
            disabled={holdPending || callStatus !== "live"}
            data-testid="coach-hold"
            onClick={onHold}
          >
            {held ? <PlayIcon className="size-4" aria-hidden /> : <PauseIcon className="size-4" aria-hidden />}
            {held ? "Resume" : "Hold"}
          </Button>
          <Button type="button" variant="destructive" size="sm" data-testid="coach-hangup" onClick={onHangup}>
            <PhoneOffIcon className="size-4" aria-hidden />
            Hang up
          </Button>
        </div>
      </div>
    </div>
  );
}
