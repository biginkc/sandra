"use server";

import type {
  JitterAudioHealthSample,
  JitterCancelReason,
  JitterConnectPhase,
} from "./jitter-contract";
import {
  cancelAuthenticatedJitterCall,
  cancelJitterCallByStartIntent,
  connectAuthenticatedJitterCall,
  getAuthenticatedJitterToken,
  getAuthenticatedJitterCallerIds,
  reportAuthenticatedJitterAudioHealth,
  sendAuthenticatedJitterDigit,
  startAuthenticatedJitterCall,
  mintStartIntent,
} from "./jitter-server";
import {
  isSimulatedTransportEnabled,
  type CallTarget,
} from "./transport";

export async function startJitterSoftphoneCall(target: CallTarget) {
  return startAuthenticatedJitterCall(target);
}

export async function mintJitterStartIntent() {
  return mintStartIntent();
}

export async function loadJitterSoftphoneCallerIds() {
  if (isSimulatedTransportEnabled()) {
    return {
      ok: true as const,
      data: {
        caller_ids: [
          { phone_e164: "+18165550100", label: "Simulated company number" },
        ],
      },
    };
  }
  return getAuthenticatedJitterCallerIds();
}

export async function getJitterSoftphoneToken(callId: string) {
  return getAuthenticatedJitterToken(callId);
}

export async function connectJitterSoftphoneCall(
  callId: string,
  phase: JitterConnectPhase,
) {
  return connectAuthenticatedJitterCall(callId, phase);
}

export async function cancelJitterSoftphoneCall(
  callId: string,
  reason: JitterCancelReason,
) {
  return cancelAuthenticatedJitterCall(callId, reason);
}

export async function cancelJitterSoftphoneCallByStartIntent(
  intentCapability: string,
  reason: JitterCancelReason,
) {
  return cancelJitterCallByStartIntent(intentCapability, reason);
}

export async function reportJitterSoftphoneAudioHealth(
  callId: string,
  sample: JitterAudioHealthSample,
) {
  return reportAuthenticatedJitterAudioHealth(callId, sample);
}

export async function sendJitterSoftphoneDigit(callId: string, digit: string) {
  return sendAuthenticatedJitterDigit(callId, digit);
}
