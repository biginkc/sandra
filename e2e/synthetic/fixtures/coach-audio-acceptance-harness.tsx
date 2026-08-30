/* eslint-disable react-hooks/refs -- this non-shipping fixture deliberately models the SDK's imperative mutable handles */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SoftphoneProvider } from "@/components/softphone/softphone-provider";
import type { CoachCallContext } from "@/lib/coach/types";
import type { JitterAudioHealthSample } from "@/lib/dialer/jitter-contract";
import { JitterCallTransport, type JitterTransportDependencies } from "@/lib/dialer/jitter-transport";
import type { CallTransportState } from "@/lib/dialer/transport";
import { configureSyntheticCoachContext } from "./coach-context-actions-browser-stub";
import { emitSyntheticCoachBroadcast } from "./coach-supabase-browser-stub";

const CONTEXT: CoachCallContext = {
  sellerName: "Synthetic Homeowner", propertyAddress: "100 Test Avenue", propertyCounty: "Example",
  repName: "Synthetic Coach", repPhoneE164: "+18165550100", motivation: "simplify a planned move",
  leadId: "synthetic-lead", sellerPhoneE164: "+18165550101", coldCallerName: "Test Caller",
  yearBuilt: "1990", leadSource: "cold_call", occupancy: "owner_occupied",
};
type AudioStimulus = "readyNoAttach" | "frozenRtp" | "advancingRtp" | "providerTerminalConfirmed" | "loseHoldAck" | "confirmHealth" | "heldReconnect" | "holdReapplyFailure" | "rejectMute" | "rejectUnmute" | "rejectHold" | "rejectResume" | "providerHeldUpdate" | "providerActiveUpdate";

class FakeRtcClient {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  calls: FakeCall[] = [];
  socketDisconnectCount = 0; serverDisconnectCount = 0; disconnectCount = 0; onFirstConnect: (() => void) | null = null;
  on(name: string, handler: (...args: unknown[]) => void): this { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); return this; }
  emit(name: string, value?: unknown): void { for (const handler of this.handlers.get(name) ?? []) handler(value); }
  async connect(): Promise<void> { this.emit("telnyx.ready"); const attach = this.onFirstConnect; this.onFirstConnect = null; attach?.(); }
  async disconnect(): Promise<void> { this.disconnectCount += 1; }
  socketDisconnect(): void { this.socketDisconnectCount += 1; this.emit("telnyx.socket.close"); this.emit("telnyx.ready"); }
  serverDisconnect(): void {
    this.serverDisconnectCount += 1;
    for (const call of this.calls) void call.hangup({ initiator: "sdk:server-disconnect" }, false);
    this.calls = [];
    this.handlers.clear();
  }
}
class FakeCall {
  direction = "inbound"; state = "ringing"; cause = ""; sipCode = 0; sipReason = ""; hangupCount = 0;
  manualAppHangupCount = 0; localPurgeHangupCount = 0; byeSendingHangupCount = 0;
  muteCount = 0; unmuteCount = 0; rejectMute = false; rejectUnmute = false;
  rejectHold = false; rejectResume = false;
  onMuteCount: ((count: number) => void) | null = null; onUnmuteCount: ((count: number) => void) | null = null;
  peer?: { instance: RTCPeerConnection };
  constructor(public id: string, public recoveredCallId?: string) {}
  async answer(): Promise<void> {}
  async hangup(_params?: unknown, execute = true): Promise<void> {
    this.hangupCount += 1;
    if (!execute) this.localPurgeHangupCount += 1;
    else { this.manualAppHangupCount += 1; this.byeSendingHangupCount += 1; }
  }
  muteAudio(): void { this.muteCount += 1; this.onMuteCount?.(this.muteCount); if (this.rejectMute) throw new Error("synthetic mute rejection"); }
  unmuteAudio(): void { this.unmuteCount += 1; this.onUnmuteCount?.(this.unmuteCount); if (this.rejectUnmute) throw new Error("synthetic unmute rejection"); }
  async hold(): Promise<unknown> { if (this.rejectHold) return false; this.state = "held"; }
  async unhold(): Promise<unknown> { if (this.rejectResume) return false; this.state = "active"; }
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
function AudioAcceptanceHarness() {
  const rtc = useRef(new FakeRtcClient());
  const call = useRef(new FakeCall("browser-leg-1"));
  const legs = useRef<FakeCall[]>([call.current]);
  const scheduledHealth = useRef<(() => void) | null>(null);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  const reportMode = useRef<"healthy" | "suspect">("healthy");
  const reportAccepted = useRef(true);
  const providerTerminal = useRef(false);
  const transport = useRef<JitterCallTransport | null>(null);
  const [history, setHistory] = useState<CallTransportState[]>([]);
  const [playCount, setPlayCount] = useState(0);
  const [reports, setReports] = useState<JitterAudioHealthSample[]>([]);
  const [providerChecks, setProviderChecks] = useState(0);
  const providerChecksRef = useRef(0);
  const terminalResponsesRef = useRef(0);
  const terminalResponseBaseline = useRef(0);
  const [terminalResponses, setTerminalResponses] = useState(0);
  const [cancelRequests, setCancelRequests] = useState(0);
  const [manualHangups, setManualHangups] = useState(0);
  const [muteCalls, setMuteCalls] = useState(0);
  const [unmuteCalls, setUnmuteCalls] = useState(0);
  const [healthScheduled, setHealthScheduled] = useState(false);
  const [terminalSource, setTerminalSource] = useState<"provider" | "manual" | null>(null);
  call.current.onMuteCount = setMuteCalls;
  call.current.onUnmuteCount = setUnmuteCalls;
  if (!rtc.current.calls.includes(call.current)) rtc.current.calls.push(call.current);

  if (!transport.current) {
    const dependencies: JitterTransportDependencies = {
      prepareMicrophone: async () => undefined,
      startCall: async () => ({ ok: true, data: { callId: "synthetic-call", batchId: "synthetic-batch" }, ambiguous: false }),
      getToken: async () => ({ ok: true, data: { rtc_token: "synthetic-token", sip_identity: "synthetic-operator", expires_at: "2099-01-01T00:00:00.000Z", capabilities: { audio_health_media_state: "v1" } } }),
      getProviderStatus: async () => {
        providerChecksRef.current += 1;
        setProviderChecks(providerChecksRef.current);
        if (providerTerminal.current) {
          terminalResponsesRef.current += 1;
          setTerminalResponses(terminalResponsesRef.current);
          return { ok: true as const, data: { state: "terminal" as const, outcome: "ended" as const } };
        }
        return { ok: true as const, data: { state: "active" as const } };
      },
      recoverAudio: async () => ({ ok: true, data: { recovering: true } }),
      connect: async () => ({ ok: true, data: { dialing: true } }),
      cancel: async () => { setCancelRequests((n) => n + 1); return { ok: true as const, data: { call_id: "synthetic-call", session_id: "synthetic-session", status: "ended" as const, teardown: { released_batch_claims: 0, revoked_bindings: 0, revoked_device_leases: 0, ended_shifts: 0, released_worker_leases: 0 } } }; },
      reportAudioHealth: async (_id, sample) => { setReports((all) => [...all, sample]); return { ok: true, data: { accepted: reportAccepted.current, status: reportMode.current } }; },
      sendDigit: async () => ({ ok: true, data: { sent: true } }),
      createRtcClient: async () => rtc.current,
      createRemoteAudio: () => { const audio = document.createElement("audio"); audio.play = async () => { setPlayCount((n) => n + 1); }; remoteAudio.current = audio; return audio; },
      subscribePageHide: () => () => undefined, sendCancelBeacon: () => false, sleep: async () => undefined,
      scheduleAudioHealth: (handler) => { scheduledHealth.current = handler; setHealthScheduled(true); return () => { scheduledHealth.current = null; setHealthScheduled(false); }; },
      now: () => Date.parse("2026-08-29T20:00:00.000Z"), registrationTimeoutMs: 100,
    };
    const instance = new JitterCallTransport(dependencies);
    const manualHangup = instance.hangup.bind(instance);
    instance.hangup = async () => {
      setTerminalSource("manual");
      setManualHangups((n) => n + 1);
      return manualHangup();
    };
    transport.current = instance;
    const bindState = instance.onStateChange.bind(instance);
    instance.onStateChange = (listener) => bindState((state) => {
      setHistory((all) => [...all, state]);
      listener(state);
    });
    rtc.current.onFirstConnect = () => {
      call.current.state = "active";
      attachPeer(call.current, true);
      rtc.current.emit("telnyx.notification", { type: "callUpdate", call: call.current });
    };
  }

  useEffect(() => {
    const timer = setTimeout(() => emitSyntheticCoachBroadcast({
      type: "transcript", speaker: "seller",
      text: "This synthetic conversation contains no personal information.",
      isFinal: true, ts: "synthetic-audio-transcript",
      scriptVersion: "1.1.0", matcherVersion: "synthetic",
    }), 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    window.coachAudioAcceptanceHarness = {
      readyNoAttach: async () => {
        if (!scheduledHealth.current) throw new Error("readyNoAttach stimulated before transport live readiness");
        remoteAudio.current?.dispatchEvent(new Event("stalled"));
      },
      frozenRtp: async () => {
        if (!scheduledHealth.current) throw new Error("frozenRtp stimulated before audio-health readiness");
        reportMode.current = "suspect"; attachPeer(call.current, false); scheduledHealth.current(); await Promise.resolve(); await Promise.resolve();
      },
      advancingRtp: async () => {
        if (!scheduledHealth.current) throw new Error("advancingRtp stimulated before transport live readiness");
        reportMode.current = "healthy";
        const replacement = new FakeCall("browser-leg-2", call.current.id); replacement.state = "active"; attachPeer(replacement, true); call.current = replacement; legs.current.push(replacement); rtc.current.calls.push(replacement);
        rtc.current.emit("telnyx.notification", { type: "callUpdate", call: replacement });
        await new Promise((resolve) => setTimeout(resolve, 0));
        scheduledHealth.current?.(); await Promise.resolve();
        scheduledHealth.current?.(); await Promise.resolve();
      },
      providerTerminalConfirmed: async () => {
        terminalResponseBaseline.current = terminalResponsesRef.current;
        setTerminalSource("provider"); providerTerminal.current = true; call.current.state = "destroy"; rtc.current.emit("telnyx.notification", { type: "callUpdate", call: call.current }); await Promise.resolve(); await Promise.resolve();
      },
      loseHoldAck: async () => { reportAccepted.current = false; },
      confirmHealth: async () => { reportAccepted.current = true; scheduledHealth.current?.(); await Promise.resolve(); },
      heldReconnect: async () => {
        const replacement = new FakeCall(`browser-leg-${legs.current.length + 1}`, call.current.id);
        replacement.state = "held"; attachPeer(replacement, false); call.current = replacement; legs.current.push(replacement); rtc.current.calls.push(replacement);
        rtc.current.emit("telnyx.notification", { type: "callUpdate", call: replacement }); await Promise.resolve(); await Promise.resolve();
      },
      holdReapplyFailure: async () => {
        const replacement = new FakeCall(`browser-leg-${legs.current.length + 1}`, call.current.id);
        replacement.state = "active"; attachPeer(replacement, true);
        replacement.hold = async () => false as unknown as void;
        call.current = replacement; legs.current.push(replacement); rtc.current.calls.push(replacement);
        rtc.current.emit("telnyx.notification", { type: "callUpdate", call: replacement }); await Promise.resolve(); await Promise.resolve();
      },
      rejectMute: async () => { call.current.rejectMute = true; },
      rejectUnmute: async () => { call.current.rejectUnmute = true; },
      rejectHold: async () => { call.current.rejectHold = true; },
      rejectResume: async () => { call.current.rejectResume = true; },
      providerHeldUpdate: async () => {
        call.current.state = "held";
        rtc.current.emit("telnyx.notification", { type: "callUpdate", call: call.current });
        await Promise.resolve();
      },
      providerActiveUpdate: async () => {
        call.current.state = "active";
        rtc.current.emit("telnyx.notification", { type: "callUpdate", call: call.current });
        await Promise.resolve();
      },
    };
  }, []);

  const evidence = <div hidden data-testid="transport-evidence">
    <output data-testid="transport-state-history">{history.join("|")}</output><output data-testid="remote-audio-play-count">{playCount}</output>
    <output data-testid="health-report-count">{reports.length}</output><output data-testid="last-health-packets">{reports.at(-1)?.packets_received ?? "none"}</output>
    <output data-testid="last-two-health-samples">{JSON.stringify(reports.slice(-2).map((sample) => ({ generation: sample.peer_connection_generation, packets: sample.packets_received, bytes: sample.bytes_received })))}</output>
    <output data-testid="provider-status-request-count">{providerChecks}</output><output data-testid="cancel-request-count">{cancelRequests}</output>
    <output data-testid="provider-terminal-response-count">{terminalResponses}</output><output data-testid="provider-terminal-response-baseline">{terminalResponseBaseline.current}</output>
    <output data-testid="sdk-hangup-count">{legs.current.reduce((sum, leg) => sum + leg.hangupCount, 0)}</output><output data-testid="manual-hangup-count">{manualHangups}</output>
    <output data-testid="manual-app-sdk-hangup-count">{legs.current.reduce((sum, leg) => sum + leg.manualAppHangupCount, 0)}</output>
    <output data-testid="local-purge-hangup-count">{legs.current.reduce((sum, leg) => sum + leg.localPurgeHangupCount, 0)}</output>
    <output data-testid="bye-sending-hangup-count">{legs.current.reduce((sum, leg) => sum + leg.byeSendingHangupCount, 0)}</output>
    <output data-testid="leg-hangup-counts">{legs.current.map((leg) => leg.hangupCount).join(",")}</output>
    <output data-testid="sdk-mute-count">{muteCalls}</output><output data-testid="sdk-unmute-count">{unmuteCalls}</output>
    <output data-testid="socket-disconnect-count">{rtc.current.socketDisconnectCount}</output><output data-testid="destructive-disconnect-count">{rtc.current.disconnectCount}</output>
    <output data-testid="server-disconnect-count">{rtc.current.serverDisconnectCount}</output>
    <output data-testid="transport-ready">{history.includes("live") && healthScheduled ? "ready" : "not-ready"}</output>
  </div>;
  return <SoftphoneProvider transportFactory={() => transport.current!}>{evidence}<output hidden data-testid="terminal-source">{terminalSource ?? "none"}</output></SoftphoneProvider>;
}
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root for coach audio acceptance harness");
configureSyntheticCoachContext("immediate", CONTEXT);
window.sessionStorage.setItem("sandra.softphone.active-call.v1", JSON.stringify({
  handle: { id: "synthetic-call" },
  target: { propertyId: CONTEXT.leadId, contactId: "synthetic-contact", phoneE164: CONTEXT.sellerPhoneE164, maskedPhone: "(816) 555-0101", name: CONTEXT.sellerName, address: CONTEXT.propertyAddress, state: "MO", startedAt: "2026-08-29T20:00:00.000Z", repName: CONTEXT.repName },
  startedAt: "2026-08-29T20:00:00.000Z",
  wrapToken: "11111111-1111-4111-8111-111111111111",
}));
createRoot(rootElement).render(<AudioAcceptanceHarness />);
