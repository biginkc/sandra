// KPI parity rules for the next-step relabel (TECH-PLAN Phase 4, item 4.6).
//
// Every key `fn_get_acquisition_kpis` returns is classified here. A key missing from RULES fails the
// unit test (kpi-rules.test.ts), so a future KPI addition forces a classification instead of
// silently passing parity.

export const EQUAL_IN_CLOSED_WINDOWS = "EQUAL_IN_CLOSED_WINDOWS";
export const EQUAL_UNLESS_CLOSEOUT = "EQUAL_UNLESS_CLOSEOUT";
export const CURRENT_STATE_MAY_CHANGE = "CURRENT_STATE_MAY_CHANGE";

/** Float keys compared with a tolerance instead of strict equality. */
export const FLOAT_TOLERANCE = { firstCallElapsedSeconds: 1e-6 };

export const RULES = Object.freeze({
  attempts: EQUAL_IN_CLOSED_WINDOWS,
  reached: EQUAL_IN_CLOSED_WINDOWS,
  offersSent: EQUAL_IN_CLOSED_WINDOWS,
  firstCallSamples: EQUAL_IN_CLOSED_WINDOWS,
  firstCallPending: EQUAL_IN_CLOSED_WINDOWS,
  firstCallElapsedSeconds: EQUAL_IN_CLOSED_WINDOWS,
  appointmentsDue: EQUAL_IN_CLOSED_WINDOWS,
  appointmentsHeld: EQUAL_IN_CLOSED_WINDOWS,
  orgAppointmentsUnattributed: EQUAL_IN_CLOSED_WINDOWS,
  missingRecordings: EQUAL_IN_CLOSED_WINDOWS,
  recordingExpectationUnknown: EQUAL_IN_CLOSED_WINDOWS,
  averageTalkSeconds: EQUAL_IN_CLOSED_WINDOWS,
  talkTimeSamples: EQUAL_IN_CLOSED_WINDOWS,
  talkTimeUnknown: EQUAL_IN_CLOSED_WINDOWS,
  conversationsOverFiveMinutes: EQUAL_IN_CLOSED_WINDOWS,
  pendingOutcomes: EQUAL_UNLESS_CLOSEOUT,
  staleLeads: CURRENT_STATE_MAY_CHANGE,
  contactWithoutFollowUp: CURRENT_STATE_MAY_CHANGE,
  needsOffers: CURRENT_STATE_MAY_CHANGE,
  appointmentsOverdue: CURRENT_STATE_MAY_CHANGE,
  lastAttemptAt: CURRENT_STATE_MAY_CHANGE,
  asOf: CURRENT_STATE_MAY_CHANGE,
  lastAttemptClockVersion: CURRENT_STATE_MAY_CHANGE,
});

/**
 * The top-level keys of the function's final `jsonb_build_object`, parsed from the migration that
 * owns the newest `fn_get_acquisition_kpis` body. Only depth-0 quoted literals that are followed by a
 * comma and preceded by `(` or `,` are keys; string values inside nested sub-selects sit at depth > 0.
 */
export function kpiKeysFromMigrationSource(sql) {
  const start = sql.lastIndexOf("function public.fn_get_acquisition_kpis");
  if (start < 0) throw new Error("fn_get_acquisition_kpis not found in the migration source");
  const fn = sql.slice(start);
  const build = fn.lastIndexOf("jsonb_build_object(", fn.search(/\n\$\$;?\s*\n/) > 0 ? fn.search(/\n\$\$;?\s*\n/) : fn.length);
  if (build < 0) throw new Error("fn_get_acquisition_kpis has no jsonb_build_object");
  const keys = [];
  let depth = 0;
  let prev = "(";
  let i = build + "jsonb_build_object(".length;
  while (i < fn.length) {
    const ch = fn[i];
    if (ch === "'") {
      const close = fn.indexOf("'", i + 1);
      if (close < 0) break;
      const literal = fn.slice(i + 1, close);
      const after = fn.slice(close + 1).match(/^\s*,/);
      if (depth === 0 && after && (prev === "(" || prev === ",") && /^[a-zA-Z][A-Za-z0-9]*$/.test(literal)) keys.push(literal);
      i = close + 1;
      prev = "'";
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return [...new Set(keys)];
}

/** Throws unless every key is classified and no rule names an unknown key. */
export function assertRulesCoverKeys(keys) {
  const unknown = Object.keys(RULES).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in RULES));
  if (unknown.length || missing.length) {
    throw new Error(`KPI rules drift: unclassified=[${missing.join(",")}] stale=[${unknown.join(",")}]`);
  }
}
