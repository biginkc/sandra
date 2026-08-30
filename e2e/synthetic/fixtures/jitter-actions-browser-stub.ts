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
