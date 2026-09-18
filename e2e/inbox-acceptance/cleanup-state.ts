export type AcceptanceProjectionStateRow = {
  queue_pending: boolean;
  parent_pending: boolean;
  safety_pending: boolean;
  maintained_rows: number;
  summary_rows: number;
  filter_rows: number;
};

export type AcceptanceProjectionState = {
  queuePending: boolean;
  parentPending: boolean;
  safetyPending: boolean;
  maintainedRows: number;
  summaryRows: number;
  filterRows: number;
};

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Projection drain returned invalid ${field}.`);
  }
}

function assertCount(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Projection drain returned invalid ${field}.`);
  }
}

/** Decode the actual PostgreSQL snake_case aliases before evaluating drain. */
export function decodeAcceptanceProjectionState(
  row: AcceptanceProjectionStateRow,
): AcceptanceProjectionState {
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

export function isAcceptanceProjectionDrained(
  state: AcceptanceProjectionState,
): boolean {
  return (
    !state.queuePending &&
    !state.parentPending &&
    !state.safetyPending &&
    state.maintainedRows === 0 &&
    state.summaryRows === 0 &&
    state.filterRows === 0
  );
}

