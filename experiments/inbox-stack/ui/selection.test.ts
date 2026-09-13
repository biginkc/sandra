import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  initialState,
  key,
  begin,
  move,
  end,
  cancel,
  toggle,
  open,
  remove,
  escape,
  type Target,
  type State,
  type Row,
} from "./selection.js";
const a: Target = { kind: "conversation", orgId: "o", conversationId: "a" };
const b: Target = { kind: "conversation", orgId: "o", conversationId: "b" };
const c: Target = { kind: "unknown", orgId: "o", senderGroupId: "a" };
const d: Target = {
  kind: "conversation",
  orgId: "o",
  conversationId: "arrival",
};
const row = (target: Target, top: number): Row => ({
  target,
  left: 0,
  right: 100,
  top,
  bottom: top + 10,
});
const rows = [row(a, 0), row(b, 20), row(c, 40)];
const down = (
  s: State,
  t: Target | null,
  shift = false,
  eligible = [a, b, c],
) => begin(s, { point: { x: 0, y: 0 }, target: t, shift, eligible });
const ids = (s: State) => s.selected.map(key);
const selected = (s: State, targets: Target[]) =>
  assert.deepEqual(ids(s), targets.map(key));
const cases: string[] = [];
function test(name: string, fn: () => void) {
  fn();
  cases.push(name);
}
test("ordinary click replaces; shift click adds and removes individual skipped rows", () => {
  let s = end(down(initialState(), a));
  s = end(down(s, c, true));
  selected(s, [a, c]);
  s = end(down(s, a, true));
  selected(s, [c]);
  s = end(down(s, b));
  selected(s, [b]);
});
test("shift rectangle engages by movement, accumulates touched IDs, ignores arrivals", () => {
  let s = toggle(initialState(), c);
  s = down(s, null, true);
  s = move(s, { x: 90, y: 25 }, [...rows, row(d, 15)]);
  selected(s, [c, a, b]);
  s = move(s, { x: 5, y: 5 }, rows);
  selected(s, [c, a, b]);
  selected(end(s), [c, a, b]);
});
test("movement under threshold remains a click without any hold delay", () => {
  const s = move(down(initialState(), a, true), { x: 1, y: 1 }, rows);
  assert.equal(s.gesture?.mode, "pending");
  selected(end(s), [a]);
});
test("ordinary drag of selected row preserves group; unselected row drags alone", () => {
  let s = toggle(toggle(initialState(), a), c);
  s = move(down(s, a), { x: 8, y: 0 }, rows);
  selected(s, [a, c]);
  assert.equal(s.gesture?.mode, "drag");
  s = end(s);
  s = move(down(s, b), { x: 8, y: 0 }, rows);
  selected(s, [b]);
});
test("cancel and lost capture restore baseline, not a partially assembled selection", () => {
  const base = toggle(initialState(), c);
  const s = move(down(base, a), { x: 8, y: 0 }, rows);
  selected(cancel(s), [c]);
  selected(cancel(cancel(s)), [c]);
  selected(cancel(move(down(base, null, true), { x: 90, y: 25 }, rows)), [c]);
});
test("unmounted/filter/page rows retain selection; authoritative removal survives cancel", () => {
  let s = toggle(toggle(initialState(), a), b);
  s = down(s, null, true);
  s = move(s, { x: 90, y: 60 }, []);
  selected(s, [a, b]);
  s = remove(s, a, "inaccessible");
  s = cancel(s);
  selected(s, [b]);
  assert.equal(s.removals[0].reason, "inaccessible");
  s = remove(s, b, "deleted");
  selected(s, []);
  assert.equal(s.removals[1].reason, "deleted");
});
test("newly mounted row from frozen workset participates; new record does not", () => {
  let s = down(initialState(), null, true);
  s = move(s, { x: 90, y: 60 }, [row(c, 40), row(d, 20)]);
  selected(s, [c]);
});
test("removed pointer target cannot be resurrected by pointerup", () => {
  let s = down(initialState(), a);
  s = remove(s, a, "deleted");
  selected(end(s), []);
});
test("explicit Open is independent of selected targets and target kinds do not collide", () => {
  let s = toggle(toggle(initialState(), a), c);
  s = open(s, b);
  selected(s, [a, c]);
  assert.deepEqual(s.active, b);
  assert.notEqual(key(a), key(c));
});
test("keyboard toggles and input controls are ignored by row selection handlers", () => {
  let s = toggle(initialState(), a);
  s = toggle(s, a);
  selected(s, []);
  s = toggle(s, a, true);
  selected(s, []);
  s = begin(s, {
    point: { x: 0, y: 0 },
    target: a,
    shift: false,
    eligible: [a],
    fromInputControl: true,
  });
  assert.equal(s.gesture, null);
  selected(end(s), []);
});
test("Escape overlay first, gesture cancel, selection clear, then inspection close", () => {
  let s = open(toggle(initialState(), c), b);
  s = move(down(s, a), { x: 8, y: 0 }, rows);
  assert.equal(escape(s, true), s);
  s = escape(s);
  selected(s, [c]);
  assert.deepEqual(s.active, b);
  s = escape(s);
  selected(s, []);
  assert.deepEqual(s.active, b);
  s = escape(s);
  assert.equal(s.active, null);
});
writeFileSync(
  new URL("./result.json", import.meta.url),
  JSON.stringify(
    {
      suite: "selection state machine",
      passed: cases.length,
      cases,
      visualVerification: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Passed ${cases.length} selection state-machine tests`);
