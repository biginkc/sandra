"use server";

import type {
  JitterAudioHealthSample,
  JitterCancelReason,
  JitterConnectPhase,
} from "./jitter-contract";
import {
  cancelAuthenticatedJitterCall,
  connectAuthenticatedJitterCall,
  getAuthenticatedJitterToken,
  reportAuthenticatedJitterAudioHealth,
  sendAuthenticatedJitterDigit,
  startAuthenticatedJitterCall,
} from "./jitter-server";
import type { CallTarget } from "./transport";

export async function startJitterSoftphoneCall(target: CallTarget) {
  return startAuthenticatedJitterCall(target);
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

export async function reportJitterSoftphoneAudioHealth(
  callId: string,
  sample: JitterAudioHealthSample,
) {
  return reportAuthenticatedJitterAudioHealth(callId, sample);
}

export async function sendJitterSoftphoneDigit(callId: string, digit: string) {
  return sendAuthenticatedJitterDigit(callId, digit);
}
