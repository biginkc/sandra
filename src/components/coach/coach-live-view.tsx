"use client";

import { Loader2Icon, MicIcon, MicOffIcon, PauseIcon, PhoneOffIcon, PlayIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { loadCoachCallContext } from "@/lib/coach/coach-context-actions";
import { buildPhaseScriptBlock, getScriptObjection, getScriptPhase, nextPhaseId, type PhaseScriptBlock } from "@/lib/coach/script-block";
import { resolveCoachTokens } from "@/lib/coach/token-resolver";
import type {
  CoachCallContext,
  CoachHoldTimer,
  CoachObjectionCard,
  CoachPhaseId,
  CoachTranscriptLine,
  ResolvedToken,
  ResolvedTokens,
} from "@/lib/coach/types";
import { COACH_PHASE_ORDER } from "@/lib/coach/types";
import { useCoachChannel } from "@/lib/coach/use-coach-channel";
import { cn } from "@/lib/utils";

export type CoachLiveViewProps = {
  /** Channel key — `coach:{callId}` on Supabase Realtime Broadcast. */
  callId: string;
  propertyId: string | null;
  sellerPhoneE164: string | null;
  repPhoneE164: string | null;
  callName: string;
  seconds: number;
  muted: boolean;
  held: boolean;
  holdPending: boolean;
  onMute: () => void;
  onHold: () => void;
  onHangup: () => void;
  /** Shrinks back to the classic call popover — Esc does the same. */
  onCollapse: () => void;
};

function timerText(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function CoachLiveView(props: CoachLiveViewProps) {
  const {
    callId,
    propertyId,
    sellerPhoneE164,
    repPhoneE164,
    callName,
    seconds,
    muted,
    held,
    holdPending,
    onMute,
    onHold,
    onHangup,
    onCollapse,
  } = props;
  const { state, dispatch, degraded } = useCoachChannel(callId);
  const [context, setContext] = useState<CoachCallContext | null>(null);

  useEffect(() => {
    let mounted = true;
    void loadCoachCallContext({ propertyId, sellerPhoneE164, repPhoneE164 }).then((loaded) => {
      if (mounted) setContext(loaded);
    });
    return () => {
      mounted = false;
    };
    // Tokens are resolved once at dial time on purpose — they shouldn't
    // drift mid-call even if, say, the caller-id selection changes later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCollapse();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCollapse]);

  const tokens: ResolvedTokens | null = useMemo(
    () => (context ? resolveCoachTokens(context) : null),
    [context],
  );

  const displayedPhaseId = state.overriddenPhaseId ?? state.currentPhaseId;
  const scriptBlock = tokens ? buildPhaseScriptBlock(displayedPhaseId, tokens) : null;
  const upcomingId = nextPhaseId(displayedPhaseId);
  const nextBlock = tokens && upcomingId ? buildPhaseScriptBlock(upcomingId, tokens) : null;
  const gateEntries = (scriptBlock?.gates ?? []).map((gate) => ({
    ...gate,
    cleared: state.gates[gate.id] ?? false,
  }));

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
      />
      <div className="flex min-h-0 flex-1">
        <TranscriptFeed lines={state.transcript} />
        <ScriptPanel block={scriptBlock} nextBlock={nextBlock} degraded={degraded} ready={Boolean(tokens)} />
      </div>
      <ObjectionOverlay
        cards={state.objectionCards}
        onDismiss={(cardId) => dispatch({ type: "dismiss_objection", cardId })}
      />
      <CallControlDock
        callName={callName}
        seconds={seconds}
        muted={muted}
        held={held}
        holdPending={holdPending}
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
}: {
  currentPhaseId: CoachPhaseId;
  displayedPhaseId: CoachPhaseId;
  onSelectPhase: (phaseId: CoachPhaseId) => void;
  counter: { label: string; goal: number } | null;
  probeCount: number;
  holdTimer: CoachHoldTimer | null;
  gates: { id: string; display: string; cleared: boolean }[];
  degraded: boolean;
}) {
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
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
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
  useEffect(() => {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [lines]);
  return (
    <aside
      aria-label="Live transcript"
      className="hidden w-full max-w-xs shrink-0 flex-col overflow-hidden border-r border-border bg-muted/30 md:flex"
    >
      <div className="border-b border-border px-4 py-2.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">
        Transcript
      </div>
      <div ref={containerRef} data-testid="coach-transcript" className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {lines.length === 0 ? (
          <p className="text-xs text-muted-foreground">Waiting for the call to start talking…</p>
        ) : null}
        {lines.map((line) => (
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
  ready,
}: {
  block: PhaseScriptBlock | null;
  nextBlock: PhaseScriptBlock | null;
  degraded: boolean;
  ready: boolean;
}) {
  if (!ready || !block) {
    return (
      <main className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-hidden />
      </main>
    );
  }
  return (
    <main className="flex-1 overflow-y-auto p-6 md:p-10" data-testid="coach-script-panel">
      <div className="mx-auto max-w-2xl">
        <div className="mb-1 text-xs font-bold tracking-wide text-muted-foreground uppercase">
          {block.phaseName}
        </div>
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
        <ol className="space-y-3">
          {[...block.entryLines, ...block.advanceLines].map((line) => (
            <li key={line.id} data-testid="script-line" className="rounded-xl border border-border bg-card px-4 py-3">
              <p className="text-[15px] leading-relaxed">
                <span className="mr-2 text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
                  {line.speaker === "rep" ? "Say" : "Listen for"}
                </span>
                {line.segments.map((segment, index) =>
                  segment.kind === "text" ? (
                    <span key={index}>{segment.value}</span>
                  ) : (
                    <TokenChip key={index} resolved={segment.resolved} />
                  ),
                )}
              </p>
              {line.toneCue ? (
                <div className="mt-2">
                  <ToneChip text={line.toneCue} />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
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
              {nextBlock.entryLines[0]?.segments
                .map((segment) => (segment.kind === "text" ? segment.value : segment.resolved.value))
                .join("")}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function ToneChip({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
      {text}
    </span>
  );
}

function TokenChip({ resolved }: { resolved: ResolvedToken }) {
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

function ObjectionOverlay({
  cards,
  onDismiss,
}: {
  cards: CoachObjectionCard[];
  onDismiss: (cardId: string) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="pointer-events-none fixed top-20 right-4 z-[90] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2">
      {cards.map((card) => (
        <ObjectionCard key={card.id} card={card} onDismiss={() => onDismiss(card.id)} />
      ))}
    </div>
  );
}

function ObjectionCard({ card, onDismiss }: { card: CoachObjectionCard; onDismiss: () => void }) {
  const objection = getScriptObjection(card.objectionId);
  return (
    <button
      type="button"
      data-testid="objection-card"
      onClick={onDismiss}
      className="animate-in slide-in-from-right-4 pointer-events-auto rounded-2xl border border-border bg-card p-3.5 text-left shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Objection</span>
        {objection?.tonality ? <ToneChip text={objection.tonality} /> : null}
      </div>
      {objection ? (
        <div className="space-y-1.5 text-sm">
          <p>
            <span className="font-bold">Acknowledge — </span>
            {objection.acknowledge}
          </p>
          <p>
            <span className="font-bold">Disarm — </span>
            {objection.disarm}
          </p>
          <p>
            <span className="font-bold">Overcome — </span>
            {objection.overcome}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{card.objectionId}</p>
      )}
    </button>
  );
}

function CallControlDock({
  callName,
  seconds,
  muted,
  held,
  holdPending,
  onMute,
  onHold,
  onHangup,
  onCollapse,
}: {
  callName: string;
  seconds: number;
  muted: boolean;
  held: boolean;
  holdPending: boolean;
  onMute: () => void;
  onHold: () => void;
  onHangup: () => void;
  onCollapse: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-4 py-3">
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
          <div className="font-mono text-xs text-muted-foreground" data-testid="coach-call-timer">
            {timerText(seconds)}
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
          variant={held ? "default" : "outline"}
          size="sm"
          aria-pressed={held}
          disabled={holdPending}
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
  );
}
