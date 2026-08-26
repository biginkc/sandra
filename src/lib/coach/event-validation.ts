import { COACH_PHASE_ORDER, type CoachEvent, type CoachEventVersions, type CoachPhaseId, type CoachSpeaker } from "./types";

const PHASE_IDS: ReadonlySet<string> = new Set(COACH_PHASE_ORDER);
const SPEAKERS: ReadonlySet<string> = new Set<CoachSpeaker>(["rep", "seller"]);
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "transcript",
  "phase",
  "objection",
  "counter",
  "gate",
  "timer",
  "coach_note",
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

/** scriptVersion/matcherVersion are optional on every event — the producer
 * is mid-rollout of version tagging, so an event without them still
 * validates. When present, each must be a non-empty string; an invalid
 * (wrong-typed) version tag is dropped rather than treated as absent, so a
 * corrupted version string can't silently disable the mismatch check. */
function parseVersions(payload: Record<string, unknown>): CoachEventVersions {
  const versions: CoachEventVersions = {};
  if (isNonEmptyString(payload.scriptVersion)) versions.scriptVersion = payload.scriptVersion;
  if (isNonEmptyString(payload.matcherVersion)) versions.matcherVersion = payload.matcherVersion;
  return versions;
}

/**
 * Validates a broadcast payload at the trust boundary before it ever
 * reaches the reducer. A malformed event (missing field, wrong type, an
 * unrecognized phaseId) is dropped here rather than cast through — letting
 * one through as a bare `as CoachEvent` cast previously meant a bad
 * `phaseId` could set state.currentPhaseId to a value buildPhaseScriptBlock
 * can never resolve, wedging the script panel on its spinner forever.
 */
export function parseCoachEvent(payload: unknown): CoachEventParseResult {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return { ok: false, reason: "malformed", rawType: isRecord(payload) ? payload.type : undefined };
  }
  const rawType = payload.type;
  if (!KNOWN_EVENT_TYPES.has(rawType)) {
    return { ok: false, reason: "unknown_type", rawType };
  }
  const versions = parseVersions(payload);

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
      if (typeof payload.phaseId === "string" && PHASE_IDS.has(payload.phaseId) && isNonEmptyString(payload.ts)) {
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
    case "counter": {
      if (isFiniteNumber(payload.probeCount) && isNonEmptyString(payload.ts)) {
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
        isNonEmptyString(payload.startedAt) &&
        isFiniteNumber(payload.durationS) &&
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
      // phaseId is optional (a nudge isn't always tied to a specific
      // phase) — but when present it must be one of our known phases,
      // same reasoning as the `phase` event: an unrecognized phaseId
      // passed through unchecked is corruption, not a valid "no phase".
      const hasPhaseId = payload.phaseId !== undefined;
      const phaseIdValid = !hasPhaseId || (typeof payload.phaseId === "string" && PHASE_IDS.has(payload.phaseId));
      if (isNonEmptyString(payload.text) && phaseIdValid && isNonEmptyString(payload.ts)) {
        return {
          ok: true,
          event: {
            type: "coach_note",
            ...(isNonEmptyString(payload.noteId) ? { noteId: payload.noteId } : {}),
            text: payload.text,
            ...(hasPhaseId ? { phaseId: payload.phaseId as CoachPhaseId } : {}),
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
