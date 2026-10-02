// Synthetic browser fixtures must never load the server-only direct-calling action barrel.
// Keep this seam fail-closed so an accidental direct transport invocation is visible in the
// browser test instead of silently contacting a provider or database.
const unavailable = async (..._args: unknown[]): Promise<never> => {
  throw new Error("Direct-calling server actions are unavailable in synthetic browser fixtures.");
};

export const cancelDirectCallByRequest = unavailable;
export const controlDirectCall = unavailable;
export const getDirectCallStatus = unavailable;
export const getDirectCallStatusByRequest = unavailable;
export const getDirectRtcToken = unavailable;
export const startDirectCall = unavailable;
