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

/**
 * Makes the browser require the exact immutable script identity that Sandra
 * bound to this call. Keep this off while Jitter's wire rollout is mixed:
 * legacy producers omit scriptDigest, whereas the strict path deliberately
 * rejects that ambiguity before it can affect coaching state or liveness.
 */
export function isCoachWireDigestStrict(): boolean {
  // Keep the public variable lookup direct so Next.js can inline it, but
  // browser-only synthetic harnesses are allowed to have no Node process
  // shim at all. An absent shim is the safe, rollout-compatible default.
  return (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.NEXT_PUBLIC_COACH_WIRE_DIGEST_STRICT === "1"
  );
}
