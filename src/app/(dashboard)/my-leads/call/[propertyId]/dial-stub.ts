/**
 * Phase 2 click-to-dial hook (`dialLeadAction`, TECH-PLAN §2.7) is built on the sibling
 * `claude/my-leads-p2-ui` branch and is not in this PR's base. The Call button renders disabled
 * with "dialing arrives with Phase 2" while this stays null.
 *
 * TODO(p2-ui merge): replace `null` with the real `dialLeadAction` from `my-leads/dialpad-actions.ts`
 * and delete this file.
 */
export type DialLeadResult =
  | { ok: true; intentId: string }
  | { ok: false; code: "not_configured" | "dnc" | "forbidden" | "error"; message: string };

export type DialLeadAction = (input: { propertyId: string; phoneSlot: 1 | 2 | 3 }) => Promise<DialLeadResult>;

export const dialLeadAction: DialLeadAction | null = null;

export const DIAL_UNAVAILABLE_COPY = "Dialing arrives with Phase 2.";
