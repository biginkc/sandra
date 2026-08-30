export class TelnyxRTC {
  static webRTCInfo(): { supportWebRTCAudio: true } {
    return { supportWebRTCAudio: true };
  }

  constructor() {
    throw new Error("The production Telnyx SDK constructor is unreachable in the synthetic Coach harness.");
  }
}
