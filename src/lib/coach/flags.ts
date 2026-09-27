/** Mirrors the softphone transport gate in transport-selection.ts:
 * unset (or any value other than "1") keeps the classic popover; "1" opts
 * into the full-screen live-call coach view. Defaults off. */
export function isCoachUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COACH_UI_ENABLED === "1";
}

/** V2 changes only the full-screen coach composition. Keeping this separate
 * from the full-screen UI flag makes an unset V2 flag select the S4 view. */
export function isCoachScriptV2Enabled(): boolean {
  // Keep the public variable lookup direct so Next.js can inline it into the
  // client bundle, while allowing standalone browser harnesses with no Node
  // `process` shim to default safely to the S4 composition.
  return (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.NEXT_PUBLIC_COACH_SCRIPT_V2 === "1"
  );
}
