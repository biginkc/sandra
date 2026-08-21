import { JitterCallTransport } from "./jitter-transport";
import {
  isSimulatedTransportEnabled,
  SimulatedCallTransport,
  type CallTransport,
} from "./transport";

export function isJitterTransportEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SOFTPHONE_TRANSPORT === "jitter";
}

export function isSoftphoneTransportEnabled(): boolean {
  return isJitterTransportEnabled() || isSimulatedTransportEnabled();
}

export function createSoftphoneCallTransport(): CallTransport {
  if (isJitterTransportEnabled()) return new JitterCallTransport();
  if (isSimulatedTransportEnabled()) return new SimulatedCallTransport();
  throw new Error("Softphone transport is disabled");
}
