import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeAcceptanceProjectionState,
  isAcceptanceProjectionDrained,
} from "./cleanup-state.ts";

const cleared = {
  queue_pending: false,
  parent_pending: false,
  safety_pending: false,
  maintained_rows: 0,
  summary_rows: 0,
  filter_rows: 0,
};

test("decodes a cleared database row and passes the drain predicate", () => {
  assert.equal(
    isAcceptanceProjectionDrained(decodeAcceptanceProjectionState(cleared)),
    true,
  );
});

test("pending worker work fails the drain predicate", () => {
  assert.equal(
    isAcceptanceProjectionDrained(
      decodeAcceptanceProjectionState({ ...cleared, queue_pending: true }),
    ),
    false,
  );
});

test("nonzero derived rows fail the drain predicate", () => {
  assert.equal(
    isAcceptanceProjectionDrained(
      decodeAcceptanceProjectionState({ ...cleared, summary_rows: 1 }),
    ),
    false,
  );
});

test("malformed database state fails closed", () => {
  assert.throws(() =>
    decodeAcceptanceProjectionState({ ...cleared, filter_rows: -1 }),
  );
});

