export const SMS_PACING_SECONDS = {
  conservative: 14,
  steadyDefault: 8,
  push: 4,
  canary: 6,
  savedCampaignDefault: 8,
  savedCampaignMin: 2,
  customMin: 10,
  max: 600,
} as const;

export const SMS_PACING_JITTER_PCT = 0.2;

export type SmsPacingProfile = "canary";

type ValidationMode = "bulk" | "saved_campaign";

export type SmsPaceValidationResult =
  | { ok: true; paceSeconds: number }
  | { ok: false; message: string };

const BULK_FAST_PRESETS = new Set<number>([
  SMS_PACING_SECONDS.conservative,
  SMS_PACING_SECONDS.steadyDefault,
  SMS_PACING_SECONDS.push,
]);

export function validateSmsPaceSeconds(
  value: number | null | undefined,
  opts: {
    mode: ValidationMode;
    pacingProfile?: SmsPacingProfile | null;
  },
): SmsPaceValidationResult {
  if (value == null) {
    return { ok: true, paceSeconds: defaultSmsPaceSeconds(opts.mode) };
  }
  if (!Number.isInteger(value) || value <= 0 || value > SMS_PACING_SECONDS.max) {
    return { ok: false, message: paceValidationMessage(opts.mode) };
  }

  if (
    opts.pacingProfile === "canary" &&
    value === SMS_PACING_SECONDS.canary
  ) {
    return { ok: true, paceSeconds: value };
  }

  if (opts.mode === "bulk") {
    if (BULK_FAST_PRESETS.has(value) || value >= SMS_PACING_SECONDS.customMin) {
      return { ok: true, paceSeconds: value };
    }
    return { ok: false, message: paceValidationMessage(opts.mode) };
  }

  if (
    value === SMS_PACING_SECONDS.savedCampaignDefault ||
    value >= SMS_PACING_SECONDS.savedCampaignMin
  ) {
    return { ok: true, paceSeconds: value };
  }
  return { ok: false, message: paceValidationMessage(opts.mode) };
}

export function defaultSmsPaceSeconds(mode: ValidationMode): number {
  return mode === "saved_campaign"
    ? SMS_PACING_SECONDS.savedCampaignDefault
    : SMS_PACING_SECONDS.steadyDefault;
}

export function paceValidationMessage(mode: ValidationMode): string {
  if (mode === "saved_campaign") {
    return `Saved campaign pacing must be between ${SMS_PACING_SECONDS.savedCampaignMin} seconds and 10 minutes.`;
  }
  return (
    "Pacing must use a locked preset (4s push, 8s steady, 14s conservative), " +
    "the explicit 6s canary profile, or a custom value between 10 seconds and 10 minutes."
  );
}
