/* eslint-disable react-hooks/refs -- this non-shipping fixture deliberately models the SDK's imperative mutable handles */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { KeyedCoachLiveView } from "@/components/coach/keyed-coach-live-view";
import type { CoachCallStatus } from "@/components/coach/coach-live-view";
import type { CoachCallContext } from "@/lib/coach/types";
import { useCoachSession } from "@/lib/coach/use-coach-session";
import type { JitterAudioHealthSample } from "@/lib/dialer/jitter-contract";
import { JitterCallTransport, type JitterTransportDependencies } from "@/lib/dialer/jitter-transport";
import type { CallTransportState } from "@/lib/dialer/transport";
import { configureSyntheticCoachContext } from "./coach-context-actions-browser-stub";

const CONTEXT: CoachCallContext = {
  sellerName: "Synthetic Homeowner", propertyAddress: "100 Test Avenue", propertyCounty: "Example",
  repName: "Synthetic Coach", repPhoneE164: "+18165550100", motivation: "simplify a planned move",
  leadId: "synthetic-lead", sellerPhoneE164: "+18165550101", coldCallerName: "Test Caller",
  yearBuilt: "1990", leadSource: "cold_call", occupancy: "owner_occupied",
};
type AudioStimulus = "readyNoAttach" | "frozenRtp" | "advancingRtp" | "providerTerminalConfirmed";

class FakeRtcClient {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  on(name: string, handler: (...args: unknown[]) => void): this { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); return this; }
  emit(name: string, value?: unknown): void { for (const handler of this.handlers.get(name) ?? []) handler(value); }
  async connect(): Promise<void> { this.emit("telnyx.ready"); }
  async disconnect(): Promise<void> {}
  socketDisconnect(): void { this.emit("telnyx.socket.close"); this.emit("telnyx.ready"); }
}
class FakeCall {
  direction = "inbound"; state = "ringing"; cause = ""; sipCode = 0; sipReason = ""; hangupCount = 0;
  peer?: { instance: RTCPeerConnection };
  constructor(public id: string, public recoveredCallId?: string) {}
  async answer(): Promise<void> {} async hangup(): Promise<void> { this.hangupCount += 1; }
  muteAudio(): void {} unmuteAudio(): void {} async hold(): Promise<void> {} async unhold(): Promise<void> {}
}
function attachPeer(call: FakeCall, advancing: boolean): void {
  let packets = advancing ? 20 : 10;
  call.peer = { instance: {
    connectionState: "connected",
    getReceivers: () => [{ track: { kind: "audio", readyState: "live", enabled: true } }],
    getStats: async () => {
      if (advancing) packets += 1;
      return new Map([["audio", { type: "inbound-rtp", kind: "audio", packetsReceived: packets, bytesReceived: packets * 160 }]]);
    },
  } as unknown as RTCPeerConnection };
}
declare global { interface Window { coachAudioAcceptanceHarness: Record<AudioStimulus, () => Promise<void>>; } }
function visibleStatus(state: CallTransportState): CoachCallStatus | null {
  return ["connecting", "ringing", "live", "audio_reconnecting", "audio_reconnect_required", "ended", "failed"].includes(state)
    ? state as CoachCallStatus : null;
}

function AudioAcceptanceHarness() {
  const session = useCoachSession("synthetic-audio-call", CONTEXT.leadId, CONTEXT.sellerPhoneE164, CONTEXT.repPhoneE164, true);
  const seeded = useRef(false);
  const rtc = useRef(new FakeRtcClient());
  const call = useRef(new FakeCall("browser-leg-1"));
  const scheduledHealth = useRef<(() => void) | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  const reportMode = useRef<"healthy" | "suspect">("healthy");
  const providerTerminal = useRef(false);
  const transport = useRef<JitterCallTransport | null>(null);
  const [callStatus, setCallStatus] = useState<CoachCallStatus>("connecting");
  const [history, setHistory] = useState<CallTransportState[]>([]);
  const [playCount, setPlayCount] = useState(0);
  const [reports, setReports] = useState<JitterAudioHealthSample[]>([]);
  const [providerChecks, setProviderChecks] = useState(0);
  const [cancelRequests, setCancelRequests] = useState(0);
  const [manualHangups, setManualHangups] = useState(0);
  const [healthScheduled, setHealthScheduled] = useState(false);
  const [terminalSource, setTerminalSource] = useState<"provider" | "manual" | null>(null);

  if (!transport.current) {
    const dependencies: JitterTransportDependencies = {
      prepareMicrophone: async () => undefined,
      startCall: async () => ({ ok: true, data: { callId: "synthetic-call", batchId: "synthetic-batch" }, ambiguous: false }),
      getToken: async () => ({ ok: true, data: { rtc_token: "synthetic-token", sip_identity: "synthetic-operator", expires_at: "2099-01-01T00:00:00.000Z", capabilities: { audio_health_media_state: "v1" } } }),
      getProviderStatus: async () => { setProviderChecks((n) => n + 1); return providerTerminal.current ? { ok: true as const, data: { state: "terminal" as const, outcome: "ended" as const } } : { ok: true as const, data: { state: "active" as const } }; },
      recoverAudio: async () => ({ ok: true, data: { recovering: true } }),
      connect: async () => ({ ok: true, data: { dialing: true } }),
      cancel: async () => { setCancelRequests((n) => n + 1); return { ok: true as const, data: { call_id: "synthetic-call", session_id: "synthetic-session", status: "ended" as const, teardown: { released_batch_claims: 0, revoked_bindings: 0, revoked_device_leases: 0, ended_shifts: 0, released_worker_leases: 0 } } }; },
      reportAudioHealth: async (_id, sample) => { setReports((all) => [...all, sample]); return { ok: true, data: { accepted: true, status: reportMode.current } }; },
      sendDigit: async () => ({ ok: true, data: { sent: true } }),
      createRtcClient: async () => rtc.current,
      createRemoteAudio: () => { const audio = document.createElement("audio"); audio.play = async () => { setPlayCount((n) => n + 1); }; remoteAudio.current = audio; return audio; },
      subscribePageHide: () => () => undefined, sendCancelBeacon: () => false, sleep: async () => undefined,
      scheduleAudioHealth: (handler) => { scheduledHealth.current = handler; setHealthScheduled(true); return () => { scheduledHealth.current = null; setHealthScheduled(false); }; },
      now: () => Date.parse("2026-08-29T20:00:00.000Z"), registrationTimeoutMs: 100,
    };
    transport.current = new JitterCallTransport(dependencies);
    transport.current.onStateChange((state) => { setHistory((all) => [...all, state]); const next = visibleStatus(state); if (next) setCallStatus(next); });
  }

  useEffect(() => {
    if (seeded.current || !transport.current) return;
    seeded.current = true;
    session.dispatch({ type: "transcript", speaker: "seller", text: "This synthetic conversation contains no personal information.", isFinal: true, ts: "synthetic-audio-transcript", scriptVersion: "1.1.0", matcherVersion: "synthetic" });
    void transport.current.start({ phoneE164: CONTEXT.sellerPhoneE164!, callToken: "11111111-1111-4111-8111-111111111111", intentCapability: "synthetic-intent" }).then(() => {
      attachPeer(call.current, true); rtc.current.emit("telnyx.notification", { type: "callUpdate", call: call.current });
      call.current.state = "active"; rtc.current.emit("telnyx.notification", { type: "callUpdate", call: call.current });
    });
  }, [session]);

  useEffect(() => {
    window.coachAudioAcceptanceHarness = {
      readyNoAttach: async () => {
        if (callStatus !== "live" || !scheduledHealth.current) throw new Error("readyNoAttach stimulated before transport live readiness");
        remoteAudio.current?.dispatchEvent(new Event("stalled")); await transport.current?.reconnectAudio();
      },
      frozenRtp: async () => {
        if (callStatus !== "live" || !scheduledHealth.current) throw new Error("frozenRtp stimulated before audio-health readiness");
        reportMode.current = "suspect"; attachPeer(call.current, false); scheduledHealth.current(); await Promise.resolve(); await Promise.resolve();
      },
      advancingRtp: async () => {
        if (callStatus !== "live" || !scheduledHealth.current) throw new Error("advancingRtp stimulated before transport live readiness");
        reportMode.current = "healthy";
        remoteAudio.current?.dispatchEvent(new Event("stalled"));
        await transport.current?.reconnectAudio();
        const replacement = new FakeCall("browser-leg-2", call.current.id); replacement.state = "active"; attachPeer(replacement, true); call.current = replacement;
        rtc.current.emit("telnyx.notification", { type: "callUpdate", call: replacement }); await Promise.resolve(); await Promise.resolve();
      },
      providerTerminalConfirmed: async () => {
        if (callStatus !== "live") throw new Error("providerTerminalConfirmed stimulated before transport live readiness");
        setTerminalSource("provider"); providerTerminal.current = true; call.current.state = "destroy"; rtc.current.emit("telnyx.notification", { type: "callUpdate", call: call.current }); await Promise.resolve(); await Promise.resolve();
      },
    };
  }, [callStatus]);

  const evidence = <div hidden data-testid="transport-evidence">
    <output data-testid="transport-state-history">{history.join("|")}</output><output data-testid="remote-audio-play-count">{playCount}</output>
    <output data-testid="health-report-count">{reports.length}</output><output data-testid="last-health-packets">{reports.at(-1)?.packets_received ?? "none"}</output>
    <output data-testid="provider-status-request-count">{providerChecks}</output><output data-testid="cancel-request-count">{cancelRequests}</output>
    <output data-testid="sdk-hangup-count">{call.current.hangupCount}</output><output data-testid="manual-hangup-count">{manualHangups}</output>
    <output data-testid="transport-ready">{callStatus === "live" && healthScheduled ? "ready" : "not-ready"}</output>
  </div>;
  if (callStatus === "ended") return <main data-testid="coach-terminal">{evidence}<h1>Call ended</h1><p>{terminalSource === "provider" ? "The provider status endpoint confirmed the homeowner ended the call." : "The rep ended the call with Hang Up."}</p></main>;
  return <>{evidence}<KeyedCoachLiveView session={session} callName="Synthetic Homeowner" callStatus={callStatus} seconds={83} muted={false} held={false} holdPending={false}
    onDigit={() => undefined} onMute={() => undefined} onHold={() => undefined}
    onHangup={() => { setTerminalSource("manual"); setManualHangups((n) => n + 1); void transport.current?.hangup(); }}
    onReconnectAudio={() => { void transport.current?.reconnectAudio(); }} onCollapse={() => undefined}
    recommendationRequest={async (input) => ({ ok: true, requestId: input.requestId, callId: input.callId, activeSectionId: input.activeSectionId, mode: input.mode, recommendations: [], followUpQuestions: [] })} /></>;
}
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root for coach audio acceptance harness");
configureSyntheticCoachContext("immediate", CONTEXT);
createRoot(rootElement).render(<AudioAcceptanceHarness />);
