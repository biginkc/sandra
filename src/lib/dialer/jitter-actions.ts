"use server";

import type { JitterCancelReason, JitterConnectPhase } from "./jitter-contract";
import {
  cancelAuthenticatedJitterCall,
  connectAuthenticatedJitterCall,
  getAuthenticatedJitterToken,
  startAuthenticatedJitterCall,
} from "./jitter-server";
import type { CallTarget } from "./transport";

export async function startJitterSoftphoneCall(target: CallTarget) {
  return startAuthenticatedJitterCall(target);
}

export async function getJitterSoftphoneToken(callId: string) {
  return getAuthenticatedJitterToken(callId);
}

export async function connectJitterSoftphoneCall(callId: string, phase: JitterConnectPhase) {
  return connectAuthenticatedJitterCall(callId, phase);
}

export async function cancelJitterSoftphoneCall(callId: string, reason: JitterCancelReason) {
  return cancelAuthenticatedJitterCall(callId, reason);
}
