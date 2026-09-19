import {
  checkQuietHours,
  type QuietHoursCheck,
} from "@/lib/messaging/quiet-hours";

const MINUTE_MS = 60_000;
const SEARCH_HORIZON_MINUTES = 24 * 60;
const MAX_SAFE_HORIZON_MINUTES = 60;

// Keep the fixture states in the same order used by the native sequence
// integration suites.  The selector may advance the application clock to the
// next state/window, but it never moves it before the database anchor.
const CANDIDATE_STATES = ["GU", "PR", "OH", "MO", "CA", "HI"] as const;

export type SafeApplicationClock = {
  state: (typeof CANDIDATE_STATES)[number];
  applicationNow: Date;
};

function isOpen(check: QuietHoursCheck): check is Extract<QuietHoursCheck, { ok: true }> {
  return check.ok;
}

/**
 * Select an application clock/state pair whose complete scheduling horizon is
 * inside the production quiet-hours send window. The DB anchor is intentionally
 * a separate input: SQL stale-claim predicates clamp future application times
 * to database now(), so advancing this clock cannot retire a fresh claim.
 */
export function selectSafeApplicationClock(
  dbAnchor: Date,
  horizonMinutes = 30,
): SafeApplicationClock {
  if (Number.isNaN(dbAnchor.getTime())) {
    throw new Error("selectSafeApplicationClock: invalid database anchor");
  }
  if (
    !Number.isInteger(horizonMinutes) ||
    horizonMinutes < 0 ||
    horizonMinutes > MAX_SAFE_HORIZON_MINUTES
  ) {
    throw new Error(`selectSafeApplicationClock: invalid horizon ${horizonMinutes}`);
  }

  // Every supported state uses the same [08:00, 21:00) window. Its shortest
  // closed interval is 21:00→08:00 (600 minutes on spring-forward days), so
  // endpoint checks are sufficient for the bounded <=60-minute horizons used
  // by these fixtures: an endpoint pair cannot cross a closed interval.
  for (let offsetMinutes = 0; offsetMinutes <= SEARCH_HORIZON_MINUTES; offsetMinutes += 1) {
    const applicationNow = new Date(dbAnchor.getTime() + offsetMinutes * MINUTE_MS);
    const horizonEnd = new Date(applicationNow.getTime() + horizonMinutes * MINUTE_MS);
    for (const state of CANDIDATE_STATES) {
      if (
        isOpen(checkQuietHours(state, applicationNow)) &&
        isOpen(checkQuietHours(state, horizonEnd))
      ) {
        return { state, applicationNow };
      }
    }
  }

  throw new Error(
    `selectSafeApplicationClock: no supported state has an open ${horizonMinutes}-minute window after ${dbAnchor.toISOString()}`,
  );
}
