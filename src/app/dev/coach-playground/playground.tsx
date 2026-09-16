"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { KeyedCoachLiveView } from "@/components/coach/keyed-coach-live-view";
import { Button } from "@/components/ui/button";
import type { CoachRecommendationRequestFn } from "@/lib/coach/recommendation-types";
import { CLOSR_SCRIPT } from "@/lib/coach/script-block";
import { usePlaygroundSession } from "./use-playground-session";

export default function CoachPlayground() {
  const [callNumber, setCallNumber] = useState(1);
  return <PlaygroundCall key={callNumber} callNumber={callNumber} newCall={() => setCallNumber(n => n + 1)} />;
}

function PlaygroundCall({ callNumber, newCall }: { callNumber: number; newCall: () => void }) {
  const session = usePlaygroundSession(`playground-call-${callNumber}`);
  const [open, setOpen] = useState(true);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [ended, setEnded] = useState(false);
  const [requests, setRequests] = useState(0);
  const [digits, setDigits] = useState("");
  const [panelHost, setPanelHost] = useState<Element | null>(null);
  const [sellerText, setSellerText] = useState("We need to sell before October because the carrying costs are becoming painful.");

  // Keep controls inside the real modal's focus boundary without changing coach UI.
  useEffect(() => {
    const sync = () => setPanelHost(document.querySelector('[data-testid="coach-live-view"]'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const recommendationRequest = useCallback<CoachRecommendationRequestFn>(async input => {
    setRequests(n => n + 1);
    await new Promise(resolve => setTimeout(resolve, 500));
    return {
      ok: true, requestId: input.requestId, callId: input.callId,
      activeSectionId: input.activeSectionId, mode: input.mode,
      recommendations: input.mode === "automatic" ? ["Ask how moving closer to family would improve their day-to-day life."] : [],
      followUpQuestions: input.mode === "follow_up" ? [
        "What would moving closer to family make easier for you?",
        "How soon would you ideally like that move to happen?",
        "What is making the timing important right now?",
      ] : [],
    };
  }, []);

  function transcript(speaker: "seller" | "rep", text: string, isFinal: boolean) {
    session.dispatch({ type: "transcript", speaker, text, isFinal,
      ts: new Date().toISOString(), scriptVersion: CLOSR_SCRIPT.version, matcherVersion: "playground" });
  }

  const panel = (
    <details open className="fixed left-4 bottom-20 z-[90] max-h-[60vh] w-80 max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border bg-card p-3 text-card-foreground shadow-xl">
      <summary className="cursor-pointer text-sm font-semibold">Playground stimuli · Call {callNumber}</summary>
      <div className="mt-3 space-y-3 text-xs">
        <p>Local simulation · requests: {requests} · {ended ? "ended" : "live"} · {held ? "held" : "unheld"} · {muted ? "muted" : "unmuted"}</p>
        <label className="block">Seller message
          <textarea aria-label="Seller message" className="mt-1 w-full rounded border bg-background p-2 text-foreground" value={sellerText} onChange={e => setSellerText(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={ended || !sellerText.trim()} onClick={() => transcript("seller", sellerText, true)}>Seller meaningful</Button>
          <Button size="sm" disabled={ended} onClick={() => transcript("seller", "Okay", true)}>Seller filler</Button>
          <Button size="sm" disabled={ended} onClick={() => transcript("seller", "uh", false)}>Seller interim</Button>
          <Button size="sm" disabled={ended} onClick={() => transcript("rep", "Tell me more about the timing.", true)}>Rep final</Button>
        </div>
        <Button size="sm" variant="outline" disabled={ended || !session.state.transcript.some(line => line.speaker === "seller" && line.isFinal)} onClick={() => {
          document.querySelector<HTMLButtonElement>('[data-testid="follow-up-questions"]')?.click();
        }}>Request follow-up recs</Button>
        <p>Follow-ups use the coach’s normal eligibility and request limits. Responses take 500 ms. Fold this panel to inspect the UI underneath.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={ended} onClick={() => setMuted(v => !v)}>Toggle mute</Button>
          <Button size="sm" variant="outline" disabled={ended} onClick={() => setHeld(v => !v)}>Toggle hold</Button>
          <Button size="sm" variant="outline" disabled={ended} onClick={() => setEnded(true)}>Hang up</Button>
          <Button size="sm" variant="outline" onClick={() => setOpen(v => !v)}>{open ? "Collapse coach" : "Reopen coach"}</Button>
          <Button size="sm" onClick={newCall}>New call reset</Button>
        </div>
        <p>Keypad digits: {digits || "none"}</p>
      </div>
    </details>
  );

  return <>
    {!open && <main className="min-h-screen bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Live Coach playground</h1>
      <p className="mt-2 text-muted-foreground">Synthetic call {callNumber}. No phone connection required.</p>
      {!open && <Button className="mt-4" onClick={() => setOpen(true)}>Open live coach</Button>}
    </main>}
    {open && <KeyedCoachLiveView session={session} callName="Jane Homeowner" callStatus={ended ? "ended" : "live"}
      seconds={83} muted={muted} held={held} holdPending={false}
      onDigit={digit => setDigits(v => v + digit)} onMute={() => setMuted(v => !v)}
      onHold={() => setHeld(v => !v)} onHangup={() => setEnded(true)} onCollapse={() => setOpen(false)}
      recommendationRequest={recommendationRequest} />}
    {open ? panelHost && createPortal(panel, panelHost) : panel}
  </>;
}
