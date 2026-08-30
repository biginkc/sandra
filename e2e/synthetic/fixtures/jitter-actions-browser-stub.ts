const unavailable = async (): Promise<never> => {
  throw new Error("Production Jitter actions are unavailable in the synthetic Coach harness.");
};

export const cancelJitterSoftphoneCall = unavailable;
export const cancelJitterSoftphoneCallByStartIntent = unavailable;
export const connectJitterSoftphoneCall = unavailable;
export const getJitterSoftphoneToken = unavailable;
export const getJitterSoftphoneProviderStatus = unavailable;
export const recoverJitterSoftphoneAudio = unavailable;
export const reportJitterSoftphoneAudioHealth = unavailable;
export const sendJitterSoftphoneDigit = unavailable;
export const startJitterSoftphoneCall = unavailable;
export const loadJitterSoftphoneCallerIds = async () => ({
  ok: true as const,
  data: { caller_ids: [{ phone_e164: "+18165550100", label: "Synthetic" }] },
});
export const mintJitterStartIntent = async () => ({
  ok: true as const,
  data: { callToken: "11111111-1111-4111-8111-111111111111", intentCapability: "synthetic-intent" },
});
