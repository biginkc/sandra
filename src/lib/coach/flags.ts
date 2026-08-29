/** Mirrors the softphone transport gate in transport-selection.ts:
 * unset (or any value other than "1") keeps the classic popover; "1" opts
 * into the full-screen live-call coach view. Defaults off. */
export function isCoachUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COACH_UI_ENABLED === "1";
}
