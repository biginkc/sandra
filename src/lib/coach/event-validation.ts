import type { CoachEvent, CoachEventVersions, CoachPhaseId, CoachSpeaker } from "./types";
import type { ScriptBundle } from "@biginkc/coach";

const LEGACY_PHASE_IDS: ReadonlySet<string> = new Set(["introduction", "reveal", "assessment", "secure_positioning", "offer", "close"]);
const SPEAKERS: ReadonlySet<string> = new Set<CoachSpeaker>(["rep", "seller"]);
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "transcript",
  "phase",
  "objection",
  "objection_prompt",
  "motivation_prompt",
  "counter",
  "gate",
  "timer",
  "coach_note",
  "cursor",
]);

export type CoachEventParseResult =
  | { ok: true; event: CoachEvent }
  /** A recognized-shape payload with a `type` outside our known set — the
   * producer's own forward-compat additions. Dropped silently, not counted
   * as malformed: this is expected, not corruption. */
  | { ok: false; reason: "unknown_type"; rawType: unknown }
  /** A `type` we know, but the payload doesn't match the required shape —
   * this IS corruption/drift and gets counted. */
  | { ok: false; reason: "malformed"; rawType: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "boolean" ? false : typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isParseableTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

/** scriptVersion/matcherVersion are required on every wire message, per the
 * producer's verbatim wire contract (src/coach/wire-contract.ts in the
 * Jitter repo, WIRE_CONTRACT_VERSION '1.0.0'). An event missing either, or
 * carrying a wrong-typed/empty value, is malformed — not a legacy
 * unversioned event to pass through. */
function parseVersions(payload: Record<string, unknown>, rawType: string): CoachEventVersions | null {
  if (!isNonEmptyString(payload.matcherVersion)) return null;
  // Jitter's bound-script mode intentionally emits this one identity only
  // for transcript messages when no immutable binding is available. It is
  // valid transcript transport, but can never authorize script-derived
  // reducer events (which still require a non-empty scriptVersion below).
  if (rawType === "transcript" && payload.scriptVersion === null && payload.scriptDigest === null) {
    return { scriptVersion: null, scriptDigest: null, matcherVersion: payload.matcherVersion };
  }
  if (!isNonEmptyString(payload.scriptVersion)) return null;
  if (payload.scriptDigest !== undefined && payload.scriptDigest !== null && !isNonEmptyString(payload.scriptDigest)) return null;
  return {
    scriptVersion: payload.scriptVersion,
    ...(payload.scriptDigest !== undefined ? { scriptDigest: payload.scriptDigest as string | null } : {}),
    matcherVersion: payload.matcherVersion,
  };
}

/**
 * Validates a broadcast payload at the trust boundary before it ever
 * reaches the reducer. A malformed event (missing field, wrong type, an
 * unrecognized phaseId) is dropped here rather than cast through — letting
 * one through as a bare `as CoachEvent` cast previously meant a bad
 * `phaseId` could set state.currentPhaseId to a value buildPhaseScriptBlock
 * can never resolve, wedging the script panel on its spinner forever.
 */
export function parseCoachEvent(payload: unknown, bundle: ScriptBundle | null = null): CoachEventParseResult {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return { ok: false, reason: "malformed", rawType: isRecord(payload) ? payload.type : undefined };
  }
  const rawType = payload.type;
  if (!KNOWN_EVENT_TYPES.has(rawType)) {
    return { ok: false, reason: "unknown_type", rawType };
  }
  const versions = parseVersions(payload, rawType);
  if (!versions) {
    return { ok: false, reason: "malformed", rawType };
  }
  const phaseIds = bundle ? new Set(bundle.script.phases.map((phase) => phase.id)) : LEGACY_PHASE_IDS;

  switch (rawType) {
    case "transcript": {
      if (
        typeof payload.speaker === "string" &&
        SPEAKERS.has(payload.speaker) &&
        typeof payload.text === "string" &&
        typeof payload.isFinal === "boolean" &&
        isNonEmptyString(payload.ts)
      ) {
        return {
          ok: true,
          event: {
            type: "transcript",
            speaker: payload.speaker as CoachSpeaker,
            text: payload.text,
            isFinal: payload.isFinal,
            ts: payload.ts,
            ...versions,
          },
        };
      }
      break;
    }
    case "phase": {
      if (isNonEmptyString(payload.phaseId) && phaseIds.has(payload.phaseId) && isNonEmptyString(payload.ts)) {
        return {
          ok: true,
          event: { type: "phase", phaseId: payload.phaseId as CoachPhaseId, ts: payload.ts, ...versions },
        };
      }
      break;
    }
    case "objection": {
      if (isNonEmptyString(payload.objectionId) && isNonEmptyString(payload.ts)) {
        return {
          ok: true,
          event: { type: "objection", objectionId: payload.objectionId, ts: payload.ts, ...versions },
        };
      }
      break;
    }
    case "objection_prompt": {
      if (
        isNonEmptyString(payload.objectionId) && payload.objectionId.length <= 64 &&
        isNonEmptyString(payload.label) && payload.label.length <= 80 &&
        isPositiveInteger(payload.sellerTurn) &&
        isNonEmptyString(payload.classifierModel) &&
        typeof payload.questionsSha256 === "string" && /^[a-f0-9]{64}$/i.test(payload.questionsSha256) &&
        isParseableTimestamp(payload.ts)
      ) {
        return { ok: true, event: {
          type: "objection_prompt", objectionId: payload.objectionId, label: payload.label,
          sellerTurn: payload.sellerTurn, classifierModel: payload.classifierModel,
          questionsSha256: payload.questionsSha256, ts: payload.ts, ...versions,
        } };
      }
      break;
    }
    case "motivation_prompt": {
      if (
        isNonEmptyString(payload.label) && payload.label.length <= 80 &&
        // Optional owner-approved sub-type id (e.g. "inherited"). Absent = general motivation.
        (payload.subType === undefined || (typeof payload.subType === "string" && /^[a-z_]{1,64}$/.test(payload.subType))) &&
        isPositiveInteger(payload.sellerTurn) &&
        isNonEmptyString(payload.classifierModel) &&
        typeof payload.questionsSha256 === "string" && /^[a-f0-9]{64}$/i.test(payload.questionsSha256) &&
        isParseableTimestamp(payload.ts)
      ) {
        return { ok: true, event: {
          type: "motivation_prompt", label: payload.label,
          ...(payload.subType === undefined ? {} : { subType: payload.subType }),
          sellerTurn: payload.sellerTurn, classifierModel: payload.classifierModel,
          questionsSha256: payload.questionsSha256, ts: payload.ts, ...versions,
        } };
      }
      break;
    }
    case "counter": {
      if (isNonNegativeInteger(payload.probeCount) && isNonEmptyString(payload.ts)) {
        return {
          ok: true,
          event: { type: "counter", probeCount: payload.probeCount, ts: payload.ts, ...versions },
        };
      }
      break;
    }
    case "gate": {
      if (isNonEmptyString(payload.gateId) && typeof payload.cleared === "boolean" && isNonEmptyString(payload.ts)) {
        return {
          ok: true,
          event: { type: "gate", gateId: payload.gateId, cleared: payload.cleared, ts: payload.ts, ...versions },
        };
      }
      break;
    }
    case "timer": {
      if (
        isNonEmptyString(payload.timerId) &&
        isParseableTimestamp(payload.startedAt) &&
        isPositiveInteger(payload.durationS) &&
        isNonEmptyString(payload.ts)
      ) {
        return {
          ok: true,
          event: {
            type: "timer",
            timerId: payload.timerId,
            startedAt: payload.startedAt,
            durationS: payload.durationS,
            ts: payload.ts,
            ...versions,
          },
        };
      }
      break;
    }
    case "coach_note": {
      if (
        isNonEmptyString(payload.text) &&
        typeof payload.phaseId === "string" &&
        phaseIds.has(payload.phaseId) && isNonEmptyString(payload.ts)
      ) {
        return {
          ok: true,
          event: {
            type: "coach_note",
            text: payload.text,
            phaseId: payload.phaseId as CoachPhaseId,
            ts: payload.ts,
            ...versions,
          },
        };
      }
      break;
    }
    case "cursor": {
      if (
        typeof payload.phaseId === "string" &&
        phaseIds.has(payload.phaseId) &&
        isNonEmptyString(payload.branchTag) &&
        isNonEmptyString(payload.variantKey) &&
        isNonNegativeInteger(payload.lineIndex) &&
        isNonEmptyString(payload.lineText) &&
        isNonEmptyString(payload.ts)
      ) {
        return {
          ok: true,
          event: {
            type: "cursor",
            phaseId: payload.phaseId as CoachPhaseId,
            branchTag: payload.branchTag,
            variantKey: payload.variantKey,
            lineIndex: payload.lineIndex,
            lineText: payload.lineText,
            ts: payload.ts,
            ...versions,
          },
        };
      }
      break;
    }
  }
  return { ok: false, reason: "malformed", rawType };
}
