import { CLOSR_SCRIPT, resolveObjectionOvercome } from "./script-block";
import type { CoachOccupancy, ResolvedTokens } from "./types";
import { resolveDisplayText } from "./token-resolver";

export type CoachObjectionHelp =
  | {
      kind: "match";
      objectionId: string;
      label: string;
      matchedTrigger: string;
      tonality: string | null;
      acknowledge: string;
      disarm: string;
      overcome: string;
      templateNote: string | null;
    }
  | {
      kind: "no_match";
      message: string;
    };

function humanizeObjectionId(id: string): string {
  return id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveText(text: string, tokens: ResolvedTokens): string {
  return resolveDisplayText(text, tokens)
    .map((segment) => {
      if (segment.kind === "tone") return "";
      return segment.kind === "text" ? segment.value : segment.resolved.value;
    })
    .join("");
}

const NO_MATCH_RESULT: CoachObjectionHelp = {
  kind: "no_match",
  message: "No clear objection was found in the finalized homeowner speech.",
};

/** Turns a server-classified objectionId (or null for "no clear objection")
 * into the full advisory card. This is the ONLY place the approved
 * acknowledge/disarm/overcome guidance is assembled — the classifier never
 * sees or writes that text, it only names which catalog objection (if any)
 * the seller is voicing and quotes the seller's own words as evidence. An
 * objectionId that doesn't resolve to a known catalog entry is treated as
 * no-match rather than trusted blindly: the server already validates
 * against the catalog, but a client-visible id must never be assumed safe
 * just because it arrived over the wire. */
export function buildObjectionHelp(
  classification: { objectionId: string | null; evidenceQuote: string | null },
  tokens: ResolvedTokens,
  occupancy: CoachOccupancy | null,
): CoachObjectionHelp {
  if (!classification.objectionId) return NO_MATCH_RESULT;

  const objection = CLOSR_SCRIPT.objections.find((candidate) => candidate.id === classification.objectionId);
  if (!objection) return NO_MATCH_RESULT;

  return {
    kind: "match",
    objectionId: objection.id,
    label: humanizeObjectionId(objection.id),
    matchedTrigger: classification.evidenceQuote ?? "",
    tonality: objection.display.tonality,
    acknowledge: resolveText(objection.display.acknowledge, tokens),
    disarm: resolveText(objection.display.disarm, tokens),
    overcome: resolveText(resolveObjectionOvercome(objection, occupancy), tokens),
    templateNote: objection.display.template_note ? resolveText(objection.display.template_note, tokens) : null,
  };
}
