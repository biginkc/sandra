"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowDownLeftIcon, ArrowUpRightIcon, DeleteIcon, PhoneIcon, XIcon } from "lucide-react";

import {
  completeSoftphoneCall,
  loadDialerRecents,
  prepareLeadCall,
  prepareManualCall,
  resumeFailedSoftphoneCall,
  searchDialerLeads,
  type DialerRecent,
  type DialerSearchResult,
  type SoftphoneTarget,
} from "@/lib/dialer/actions";
import { SOFTPHONE_DISPOSITIONS, type SoftphoneDisposition } from "@/lib/dialer/dispositions";
import { maskPhone } from "@/lib/phone-format";
import { type CallTransport } from "@/lib/dialer/transport";
import { createSoftphoneCallTransport, isSoftphoneTransportEnabled } from "@/lib/dialer/transport-selection";
import { transitionSoftphoneState, type SoftphoneState } from "@/lib/dialer/state-machine";

export type SoftphoneLead = {
  id: string;
  contactId: string | null;
  firstName: string;
  name: string;
  address: string;
  state: string | null;
  phones: string[];
  dncLocked: boolean;
  contactDnc: boolean;
  callable: boolean;
};

type SoftphoneContextValue = {
  openLead: (lead: SoftphoneLead) => void;
  toggleOpen: () => void;
  callingEnabled: boolean;
  onCall: boolean;
  timer: string;
};
const SoftphoneContext = createContext<SoftphoneContextValue | null>(null);

export function useSoftphone(): SoftphoneContextValue {
  const value = useContext(SoftphoneContext);
  if (!value) throw new Error("useSoftphone must be used inside SoftphoneProvider");
  return value;
}

export function useOptionalSoftphone(): SoftphoneContextValue | null {
  return useContext(SoftphoneContext);
}

type Props = { children: ReactNode };

const KEYPAD = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
] as const;

function timerText(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function callbackWallTime(kind: "today_pm" | "tomorrow_am"): { date: string; time: string; timeZone: string } {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + (kind === "tomorrow_am" ? 1 : 0)));
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  return { date: nextDate, time: kind === "today_pm" ? "14:00" : "09:00", timeZone: "America/Chicago" };
}

export function SoftphoneProvider({ children }: Props) {
  const [phone, setPhone] = useState<SoftphoneState>("closed");
  const [target, setTarget] = useState<SoftphoneTarget | null>(null);
  const [dialInput, setDialInput] = useState("");
  const [suggestions, setSuggestions] = useState<DialerSearchResult[]>([]);
  const [recents, setRecents] = useState<DialerRecent[]>([]);
  const [callStatus, setCallStatus] = useState<"connecting" | "ringing" | "live" | "ended" | "failed" | null>(null);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [finalSeconds, setFinalSeconds] = useState(0);
  const [notes, setNotes] = useState("");
  const [callbackOpen, setCallbackOpen] = useState(false);
  const [callbackTime, setCallbackTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [callOutcome, setCallOutcome] = useState<"connected_human" | "failed">("connected_human");
  const [wrapToken, setWrapToken] = useState<string | null>(null);
  const [callingEnabled] = useState(() => isSoftphoneTransportEnabled());
  const transportRef = useRef<CallTransport | null>(null);
  const manualHangupRef = useRef(false);
  const startInFlightRef = useRef(false);
  const terminalHandledRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  useEffect(() => {
    if (!["live", "held", "wrap"].includes(phone) || !target?.propertyId) return;
    const propertyId = target.propertyId;
    const resumeOnPageHide = () => {
      const body = JSON.stringify({ propertyId });
      const blob = new Blob([body], { type: "application/json" });
      if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/softphone/resume", blob)) return;
      void fetch("/api/softphone/resume", { method: "POST", body, headers: { "content-type": "application/json" }, credentials: "same-origin", keepalive: true });
    };
    window.addEventListener("pagehide", resumeOnPageHide);
    return () => window.removeEventListener("pagehide", resumeOnPageHide);
  }, [phone, target?.propertyId]);

  useEffect(() => {
    if (phone !== "live" || held || callStatus !== "live") return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [callStatus, phone, held]);

  useEffect(() => {
    if (phone !== "idle" || dialInput.trim()) return;
    loadDialerRecents().then((result) => { if (result.ok) setRecents(result.data); });
  }, [phone, dialInput]);

  useEffect(() => {
    const query = dialInput.trim();
    if (!query || phone !== "idle") return;
    const timer = setTimeout(() => {
      searchDialerLeads(query).then((result) => {
        if (result.ok) setSuggestions(result.data);
        else setError(result.error);
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [dialInput, phone]);

  const transition = useCallback((event: Parameters<typeof transitionSoftphoneState>[1]) => {
    setPhone((state) => transitionSoftphoneState(state, event));
  }, []);

  const resetIdle = useCallback(() => {
    transportRef.current = null;
    manualHangupRef.current = false;
    startInFlightRef.current = false;
    terminalHandledRef.current = false;
    setTarget(null);
    setDialInput("");
    setSuggestions([]);
    setCallStatus(null);
    setMuted(false);
    setHeld(false);
    setSeconds(0);
    setFinalSeconds(0);
    setNotes("");
    setCallbackOpen(false);
    setCallbackTime("");
    setError(null);
    setStartedAt(null);
    setCallOutcome("connected_human");
    setWrapToken(null);
    setPhone("idle");
  }, []);

  const startTarget = useCallback(async (prepare: Promise<{ ok: true; data: SoftphoneTarget } | { ok: false; error: string }>) => {
    if (!callingEnabled) {
      setError("Calling not yet enabled");
      return;
    }
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
    terminalHandledRef.current = false;
    setPhone("idle");
    setPending(true);
    setError(null);
    const result = await prepare;
    setPending(false);
    if (!result.ok) {
      startInFlightRef.current = false;
      setError(result.error);
      return;
    }
    setTarget(result.data);
    setStartedAt(result.data.startedAt);
    setSeconds(0);
    setHeld(false);
    setMuted(false);
    setCallOutcome("connected_human");
    setWrapToken(null);
    const transport = createSoftphoneCallTransport();
    transportRef.current = transport;
    let terminalPromise: Promise<void> | null = null;
    const finishTerminal = (kind: "ended" | "failed") => {
      if (terminalPromise) return terminalPromise;
      terminalHandledRef.current = true;
      terminalPromise = (async () => {
        const terminalResult = await transport.hangup();
        setCallOutcome(kind === "failed" ? "failed" : terminalResult.outcome);
        setFinalSeconds(terminalResult.durationSeconds);
        setWrapToken((value) => value ?? crypto.randomUUID());
        if (kind === "failed" && result.data.propertyId) {
          await resumeFailedSoftphoneCall(result.data.propertyId);
        }
        transition(kind === "failed" ? { type: "call_failed" } : { type: "hangup" });
        if (kind === "failed") setError("The call failed. Add a note to log the outcome.");
      })();
      return terminalPromise;
    };
    transport.onStateChange((status) => {
      setCallStatus(status);
      if (status === "connecting" || status === "ringing" || status === "live") {
        transition({ type: "call_live" });
      }
      if (status === "ended" && !manualHangupRef.current) {
        void finishTerminal("ended");
      }
      if (status === "failed") void finishTerminal("failed");
    });
    transition({ type: "call_started" });
    try {
      await transport.start({ phoneE164: result.data.phoneE164, propertyId: result.data.propertyId ?? undefined, contactId: result.data.contactId ?? undefined });
    } catch {
      if (!terminalHandledRef.current) await finishTerminal("failed");
    }
  }, [callingEnabled, transition]);

  const openLead = useCallback((lead: SoftphoneLead) => {
    if (!callingEnabled || startInFlightRef.current) return;
    setPhone((state) => state === "closed" ? "idle" : state);
    void startTarget(prepareLeadCall(lead.id));
  }, [callingEnabled, startTarget]);

  const openIdle = useCallback(() => {
    if (phone === "closed") {
      transition({ type: "open" });
    } else if (phone === "idle") {
      resetIdle();
      setPhone("closed");
    }
  }, [phone, resetIdle, transition]);

  const hangup = useCallback(async () => {
    const transport = transportRef.current;
    if (!transport) return;
    manualHangupRef.current = true;
    terminalHandledRef.current = true;
    try {
      const result = await transport.hangup();
      setCallOutcome(result.outcome);
      setFinalSeconds(result.durationSeconds);
      setCallStatus("ended");
      setWrapToken((value) => value ?? crypto.randomUUID());
      transition({ type: "hangup" });
    } finally {
      manualHangupRef.current = false;
    }
  }, [transition]);

  const complete = useCallback(async (disposition: SoftphoneDisposition, callback?: { date: string; time: string; timeZone: string }) => {
    if (!target || !startedAt || !wrapToken) return;
    if (!notes.trim()) return;
    setPending(true);
    setError(null);
    try {
      const result = await completeSoftphoneCall({ target, startedAt, endedAt: new Date().toISOString(), durationSeconds: finalSeconds, outcome: callOutcome, disposition, notes, wrapToken, callback });
      if (!result.ok) { setError(result.error); return; }
      showToast(`Logged "${SOFTPHONE_DISPOSITIONS.find((item) => item.value === disposition)?.label ?? disposition}" + notes for ${target.name} · ${timerText(finalSeconds)}`);
      transition({ type: "wrap_complete" });
      resetIdle();
      setPhone("closed");
    } catch {
      setError("Could not confirm the call was saved. Try again.");
    } finally {
      setPending(false);
    }
  }, [callOutcome, finalSeconds, notes, resetIdle, showToast, startedAt, target, transition, wrapToken]);

  const manualDigits = dialInput.replace(/\D/g, "");
  const visibleSuggestions = phone === "idle" && dialInput.trim() ? suggestions : [];
  const manualReady = manualDigits.length === 10 && visibleSuggestions.length === 0;
  const callName = target?.name ?? "";
  const isOnCall = phone === "live" || phone === "held";

  const contextValue = useMemo(() => ({
    openLead,
    toggleOpen: openIdle,
    callingEnabled,
    onCall: isOnCall,
    timer: timerText(seconds),
  }), [callingEnabled, isOnCall, openIdle, openLead, seconds]);

  return (
    <SoftphoneContext.Provider value={contextValue}>
      {children}
      {typeof document !== "undefined" && phone !== "closed"
        ? createPortal(
        <>
          <button type="button" aria-label="Close dialer overlay" className="fixed inset-0 top-16 z-50 bg-stone-950/35 backdrop-blur-[3px] md:left-64" onClick={() => { if (phone === "idle") { resetIdle(); setPhone("closed"); } }} />
          <div data-testid="softphone-popover" role="dialog" aria-label="Dialer" className="fixed top-20 left-1/2 z-[60] w-[min(480px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-[#e5e1df] bg-white text-[#1c1917] shadow-[0_20px_60px_rgba(28,25,23,0.3)]">
            <button type="button" aria-label="Close dialer" className="absolute top-2.5 right-2.5 z-10 rounded-md p-1.5 text-[#78716c] hover:bg-[#f0eeec]" onClick={() => { if (phone === "idle") { resetIdle(); setPhone("closed"); } }}><XIcon className="size-3.5" /></button>
            {phone === "idle" ? (
              <IdleView
                dialInput={dialInput}
                setDialInput={setDialInput}
                suggestions={visibleSuggestions}
                recents={recents}
                manualReady={manualReady}
                manualDigits={manualDigits}
                pending={pending}
                callingEnabled={callingEnabled}
                onLead={(suggestion) => void startTarget(prepareLeadCall(suggestion.propertyId))}
                onRecent={(recent) => void startTarget(recent.propertyId ? prepareLeadCall(recent.propertyId) : prepareManualCall(recent.phoneE164))}
                onManual={() => void startTarget(prepareManualCall(manualDigits))}
                onDigit={(digit) => setDialInput((value) => value + digit)}
                onBackspace={() => setDialInput((value) => value.slice(0, -1))}
                error={error}
              />
            ) : isOnCall ? (
              <LiveView target={target} callName={callName} callStatus={callStatus} seconds={seconds} muted={muted} held={held} onMute={() => { setMuted((value) => !value); transportRef.current?.mute(!muted); }} onHold={() => { setHeld((value) => !value); transportRef.current?.hold(!held); transition(held ? { type: "resume" } : { type: "hold" }); }} onHangup={hangup} />
            ) : (
              <WrapView target={target} finalSeconds={finalSeconds} notes={notes} setNotes={setNotes} callbackOpen={callbackOpen} setCallbackOpen={setCallbackOpen} callbackTime={callbackTime} setCallbackTime={setCallbackTime} pending={pending} error={error} onDisposition={(disposition) => {
                const config = SOFTPHONE_DISPOSITIONS.find((item) => item.value === disposition);
                if (config?.schedulesCallback) { setCallbackOpen(true); return; }
                void complete(disposition);
              }} onCallback={(kind) => void complete("nurture", callbackWallTime(kind))} onCustomCallback={() => {
                if (!callbackTime) return;
                const [date, time] = callbackTime.split("T");
                void complete("nurture", { date, time, timeZone: "America/Chicago" });
              }} />
            )}
          </div>
        </>,
        document.body,
      )
        : null}
      {typeof document !== "undefined" && toast
        ? createPortal(<div role="status" className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-lg bg-[#111827] px-4 py-2.5 text-sm font-semibold text-white shadow-lg">{toast}</div>, document.body)
        : null}
    </SoftphoneContext.Provider>
  );
}

export function SoftphoneHeaderButton() {
  const { toggleOpen, onCall, timer, callingEnabled } = useSoftphone();
  return <button type="button" data-testid="header-dialer-button" aria-label={onCall ? "Open active call" : "Open dialer"} title={callingEnabled ? "Open dialer" : "Calling not yet enabled"} onClick={toggleOpen} className={onCall ? "flex h-9 items-center gap-1.5 rounded-full border border-emerald-300/50 bg-emerald-400/20 px-3.5 font-mono text-[11.5px] font-bold text-emerald-100" : "flex size-9 items-center justify-center rounded-full text-white hover:bg-white/[0.12]"}><PhoneIcon className="size-[18px]" />{onCall ? timer : null}</button>;
}

function formatFull(digits: string): string {
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
}

function IdleView({ dialInput, setDialInput, suggestions, recents, manualReady, manualDigits, pending, callingEnabled, onLead, onRecent, onManual, onDigit, onBackspace, error }: {
  dialInput: string; setDialInput: (value: string) => void; suggestions: DialerSearchResult[]; recents: DialerRecent[]; manualReady: boolean; manualDigits: string; pending: boolean; callingEnabled: boolean; onLead: (suggestion: DialerSearchResult) => void; onRecent: (recent: DialerRecent) => void; onManual: () => void; onDigit: (digit: string) => void; onBackspace: () => void; error: string | null;
}) {
  return <div className="p-4 pb-[18px]">
    {!callingEnabled ? <div role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">Calling not yet enabled</div> : null}
    <input autoFocus data-testid="dialer-input" value={dialInput} onChange={(event) => setDialInput(event.target.value)} placeholder="Type a name or number…" className="w-full rounded-[10px] border border-[#e5e1df] bg-[#fafaf9] px-3 py-2.5 text-[15px] font-semibold outline-none" />
    {suggestions.length > 0 ? <div className="mt-2 flex max-h-42 flex-col gap-0.5 overflow-auto">{suggestions.map((suggestion) => <button type="button" disabled={!callingEnabled} title={!callingEnabled ? "Calling not yet enabled" : undefined} data-testid="dialer-suggestion" key={suggestion.propertyId} onClick={() => onLead(suggestion)} className="flex w-full items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 py-2 text-left hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#f0eeec] text-[11px] font-extrabold text-[#57534e]">{initials(suggestion.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold">{suggestion.name}</span><span className="block truncate text-[11px] text-[#78716c]">{suggestion.detail}</span></span><PhoneIcon className="size-3.5 shrink-0 text-emerald-600" /></button>)}</div> : null}
    {dialInput.trim().length >= 2 && suggestions.length === 0 && !manualReady ? <div className="px-1 pt-2.5 text-[11.5px] text-[#78716c]">No matching lead — DNC-locked leads never appear here.</div> : null}
    {error ? <div role="alert" className="pt-2 text-xs text-red-700">{error}</div> : null}
    <div className="mt-3 grid grid-cols-3 gap-1.5">{KEYPAD.map(([digit, letters]) => <button type="button" key={digit} aria-label={`Keypad ${digit}`} onClick={() => onDigit(digit)} className="flex flex-col items-center rounded-[10px] border border-[#e5e1df] bg-white px-0 py-2 hover:border-[#d6d1ce] hover:bg-[#f5f4f2]"><span className="text-[17px] font-bold leading-none">{digit}</span><span className="h-2.5 text-[8px] font-bold tracking-[0.12em] text-[#a8a29e]">{letters}</span></button>)}</div>
    <div className="mt-3 flex gap-2"><button type="button" aria-label="Delete digit" onClick={onBackspace} className="flex w-11 shrink-0 items-center justify-center rounded-[10px] border border-[#e5e1df] bg-white text-[#78716c] hover:bg-[#f5f4f2]"><DeleteIcon className="size-[17px]" /></button><button type="button" data-testid="dialer-call-manual" title={!callingEnabled ? "Calling not yet enabled" : undefined} disabled={!manualReady || pending || !callingEnabled} onClick={onManual} className={`flex-1 rounded-[10px] border-0 py-2.5 text-[13px] font-bold ${manualReady && callingEnabled ? "bg-emerald-600 text-white hover:bg-emerald-700" : "cursor-default bg-[#f0eeec] text-[#a8a29e]"}`}>{callingEnabled && manualReady ? `Call ${formatFull(manualDigits)}` : "Call"}</button></div>
    {dialInput.trim() === "" ? <div className="mt-3.5 border-t border-[#e5e1df] pt-3"><div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#a8a29e]">Recent calls</div>{recents.map((recent) => <button type="button" disabled={!callingEnabled} title={!callingEnabled ? "Calling not yet enabled" : undefined} data-testid="dialer-recent" key={recent.id} onClick={() => onRecent(recent)} className="flex w-full items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"><span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${recent.missed ? "bg-red-50 text-red-600" : "bg-[#f0eeec] text-[#78716c]"}`}>{recent.missed ? <ArrowDownLeftIcon className="size-3 -scale-y-100" /> : <ArrowUpRightIcon className="size-3" />}</span><span className="min-w-0 flex-1"><span className={`block truncate text-xs font-bold ${recent.missed ? "text-red-700" : "text-[#1c1917]"}`}>{recent.name}</span><span className="block truncate text-[11px] text-[#78716c]">{recent.detail}</span></span><span className="shrink-0 text-[11px] font-semibold text-[#a8a29e]">{recent.when}</span></button>)}</div> : null}
  </div>;
}

function LiveView({ target, callName, callStatus, seconds, muted, held, onMute, onHold, onHangup }: { target: SoftphoneTarget | null; callName: string; callStatus: string | null; seconds: number; muted: boolean; held: boolean; onMute: () => void; onHold: () => void; onHangup: () => void }) {
  return <div className="p-5 pb-4 text-center"><span data-testid="call-live-pill" className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-emerald-800"><span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />{held ? "On hold" : callStatus === "connecting" ? "Connecting" : callStatus === "ringing" ? "Ringing" : "Live · browser audio"}</span><div className="mt-3.5 text-lg font-extrabold">{callName}</div><div className="mt-0.5 text-xs text-[#78716c]">{target ? `${maskPhone(target.phoneE164)}${target.address ? ` · ${target.address}` : ""}` : ""}</div><div data-testid="call-timer" className={`my-4.5 font-mono text-[34px] font-bold leading-none ${held ? "text-amber-700" : "text-emerald-600"}`}>{timerText(seconds)}</div><div className="flex justify-center gap-2"><button type="button" aria-pressed={muted} data-testid="call-mute" onClick={onMute} className={`min-w-16 rounded-[9px] border px-3 py-2 text-xs font-bold ${muted ? "border-[#111827] bg-[#111827] text-white" : "border-[#e5e1df] bg-white"}`}>{muted ? "Unmute" : "Mute"}</button><button type="button" aria-pressed={held} data-testid="call-hold" onClick={onHold} className={`min-w-16 rounded-[9px] border px-3 py-2 text-xs font-bold ${held ? "border-[#111827] bg-[#111827] text-white" : "border-[#e5e1df] bg-white"}`}>{held ? "Resume" : "Hold"}</button><button type="button" data-testid="call-hangup" onClick={onHangup} className="rounded-[9px] border-0 bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700">Hang up</button></div></div>;
}

function WrapView({ target, finalSeconds, notes, setNotes, callbackOpen, setCallbackOpen, callbackTime, setCallbackTime, pending, error, onDisposition, onCallback, onCustomCallback }: { target: SoftphoneTarget | null; finalSeconds: number; notes: string; setNotes: (value: string) => void; callbackOpen: boolean; setCallbackOpen: (value: boolean) => void; callbackTime: string; setCallbackTime: (value: string) => void; pending: boolean; error: string | null; onDisposition: (disposition: SoftphoneDisposition) => void; onCallback: (kind: "today_pm" | "tomorrow_am") => void; onCustomCallback: () => void }) {
  const disabled = !notes.trim() || pending;
  return <div className="p-[18px] pb-4 text-center"><span className="inline-flex rounded-full border border-[#e5e1df] bg-[#f6f4f2] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-[#78716c]">Call ended · {timerText(finalSeconds)}</span><div className="mt-3 text-[15px] font-extrabold">{target?.name}</div><div className="my-1.5 mb-3 text-[11.5px] text-[#78716c]">How&apos;d it go? One tap logs it and you&apos;re done.</div><textarea data-testid="dispo-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes (required) — saved to the lead with the outcome…" rows={3} className="mb-3 w-full resize-none rounded-[10px] border border-[#e5e1df] bg-[#fafaf9] px-3 py-2.5 text-[12.5px] leading-[1.5] outline-none" />{error ? <div role="alert" className="mb-2 text-xs text-red-700">{error}</div> : null}<div className="flex flex-wrap justify-center gap-1.5">{SOFTPHONE_DISPOSITIONS.map((item) => <button type="button" key={item.value} data-testid={item.testId} disabled={disabled} onClick={() => onDisposition(item.value)} className={`rounded-full border px-3 py-1.5 text-[11.5px] font-bold ${disabled ? "cursor-not-allowed border-[#e5e1df] bg-[#fafaf9] text-[#a8a29e]" : item.danger ? "border-red-200 bg-white text-red-700 hover:border-red-400 hover:bg-red-50" : "border-[#e5e1df] bg-white hover:border-[#111827] hover:bg-[#111827] hover:text-white"}`}>{item.label}</button>)}</div>{disabled ? <div className="mt-2.5 text-[11px] text-[#a8a29e]">Add a note to log the outcome.</div> : null}{callbackOpen ? <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/60 p-2.5 text-left"><div className="mb-2 text-xs font-bold text-blue-900">Schedule callback</div><div className="flex flex-wrap gap-1.5"><button type="button" onClick={() => onCallback("today_pm")} className="rounded-full border border-blue-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-blue-900">Today PM</button><button type="button" onClick={() => onCallback("tomorrow_am")} className="rounded-full border border-blue-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-blue-900">Tomorrow AM</button><input aria-label="Pick a time" type="datetime-local" value={callbackTime} onChange={(event) => setCallbackTime(event.target.value)} className="rounded-md border border-blue-200 bg-white px-2 py-1 text-[11px]" /><button type="button" onClick={onCustomCallback} disabled={!callbackTime} className="rounded-full bg-blue-700 px-2.5 py-1.5 text-[11px] font-bold text-white disabled:opacity-50">Schedule</button><button type="button" onClick={() => setCallbackOpen(false)} className="rounded-full px-2 py-1.5 text-[11px] font-bold text-[#78716c]">Cancel</button></div></div> : null}</div>;
}
