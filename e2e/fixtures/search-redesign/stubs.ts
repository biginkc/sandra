// Isolated browser overlay fixture only. No server action or provider is contacted.
import type { CallTransport, CallTransportState } from "../../../src/lib/dialer/transport";
export const loadDialerRecents = async () => ({ ok: true, data: [] });
export const searchDialerLeads = loadDialerRecents;
export const loadJitterSoftphoneCallerIds = async () => ({ ok: true, data: { caller_ids: [{ phone_e164: "+18165550100", label: "Fixture" }] } });
export const prepareLeadCall = async () => ({ ok: true, data: { propertyId: "fixture", contactId: "fixture", phoneE164: "+18165550123", maskedPhone: "(816) 555-0123", name: "Fixture caller", address: "1 Fixture Street", state: "MO", startedAt: new Date().toISOString() } });
export const prepareManualCall = prepareLeadCall;
export const completeSoftphoneCall = async () => ({ ok: true, data: {} });
export const resumeFailedSoftphoneCall = completeSoftphoneCall;
export const mintJitterStartIntent = completeSoftphoneCall;
export const isJitterTransportEnabled = () => false;
export const isSoftphoneTransportEnabled = () => true;
export const isCoachUiEnabled = () => false;
export const useCoachSession = () => null;
export const KeyedCoachLiveView = () => null;
export const playDtmfTone = () => {};
export function createSoftphoneCallTransport(): CallTransport {
  let listener: (state: CallTransportState) => void = () => {};
  return {
    onStateChange: callback => { listener = callback; },
    start: async () => { listener("live"); return { id: "fixture-call" }; },
    mute: async () => false,
    hold: async () => true,
    reconnectAudio: async () => true,
    sendDigit: async () => true,
    hangup: async () => { document.body.dataset.fixtureHangups = "1"; listener("ended"); return { durationSeconds: 1, outcome: "connected_human" }; },
  };
}
