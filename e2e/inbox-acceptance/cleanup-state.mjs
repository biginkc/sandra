/**
 * @typedef {Object} AcceptanceProjectionStateRow
 * @property {boolean} queue_pending
 * @property {boolean} parent_pending
 * @property {boolean} safety_pending
 * @property {number} maintained_rows
 * @property {number} summary_rows
 * @property {number} filter_rows
 */

/**
 * @typedef {Object} AcceptanceProjectionState
 * @property {boolean} queuePending
 * @property {boolean} parentPending
 * @property {boolean} safetyPending
 * @property {number} maintainedRows
 * @property {number} summaryRows
 * @property {number} filterRows
 */

/** @param {unknown} value @param {string} field */
function assertBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new Error(`Projection drain returned invalid ${field}.`);
  }
}

/** @param {unknown} value @param {string} field */
function assertCount(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Projection drain returned invalid ${field}.`);
  }
}

/**
 * Decode the actual PostgreSQL snake_case aliases before evaluating drain.
 * @param {AcceptanceProjectionStateRow} row
 * @returns {AcceptanceProjectionState}
 */
export function decodeAcceptanceProjectionState(row) {
  assertBoolean(row.queue_pending, "queue_pending");
  assertBoolean(row.parent_pending, "parent_pending");
  assertBoolean(row.safety_pending, "safety_pending");
  assertCount(row.maintained_rows, "maintained_rows");
  assertCount(row.summary_rows, "summary_rows");
  assertCount(row.filter_rows, "filter_rows");
  return {
    queuePending: row.queue_pending,
    parentPending: row.parent_pending,
    safetyPending: row.safety_pending,
    maintainedRows: row.maintained_rows,
    summaryRows: row.summary_rows,
    filterRows: row.filter_rows,
  };
}

/** @param {AcceptanceProjectionState} state */
export function isAcceptanceProjectionDrained(state) {
  return (
    !state.queuePending &&
    !state.parentPending &&
    !state.safetyPending &&
    state.maintainedRows === 0 &&
    state.summaryRows === 0 &&
    state.filterRows === 0
  );
}
