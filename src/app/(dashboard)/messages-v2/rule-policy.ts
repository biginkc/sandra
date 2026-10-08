/**
 * Labels that must never be automated, whatever an owner clicks. The editor
 * disables "On" for them and `setLabelRule` refuses to enable them server-side
 * (before the RPC), so the policy holds even against a hand-built request.
 */
export const NEVER_AUTO: ReadonlySet<string> = new Set(["opted_out", "dnc"]);

export const isNeverAuto = (outcome: string): boolean => NEVER_AUTO.has(outcome);

export const NEVER_AUTO_NOTE = "Held for a person by policy";
export const NEW_LEAD_AUTO_NOTE = "Jev will promote leads automatically";
