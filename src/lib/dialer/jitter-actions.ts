"use server";

import type { JitterCancelReason } from "./jitter-contract";
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

export async function getJitterSoftphoneToken(sessionRef: string) {
  return getAuthenticatedJitterToken(sessionRef);
}

export async function connectJitterSoftphoneCall(sessionRef: string) {
  return connectAuthenticatedJitterCall(sessionRef);
}

export async function cancelJitterSoftphoneCall(sessionRef: string, reason: JitterCancelReason) {
  return cancelAuthenticatedJitterCall(sessionRef, reason);
}
