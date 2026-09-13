/** Framework-independent selection. All coordinates share a caller-owned space. */
export type Target =
  | { kind: "conversation"; orgId: string; conversationId: string }
  | { kind: "unknown"; orgId: string; senderGroupId: string };
export type Point = { x: number; y: number };
export type Row = {
  target: Target;
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export type Removal = { target: Target; reason: "deleted" | "inaccessible" };
type Gesture = {
  origin: Point;
  target: Target | null;
  shift: boolean;
  baseline: readonly Target[];
  eligible: readonly Target[];
  mode: "pending" | "rectangle" | "drag";
};
export type State = {
  selected: readonly Target[];
  active: Target | null;
  gesture: Gesture | null;
  removals: readonly Removal[];
};
export const initialState = (): State => ({
  selected: [],
  active: null,
  gesture: null,
  removals: [],
});
export const key = (t: Target): string =>
  JSON.stringify([
    t.orgId,
    t.kind,
    t.kind === "conversation" ? t.conversationId : t.senderGroupId,
  ]);
const contains = (items: readonly Target[], target: Target) =>
  items.some((t) => key(t) === key(target));
const union = (a: readonly Target[], b: readonly Target[]): Target[] => {
  const all = new Map(a.map((t) => [key(t), t]));
  for (const t of b) all.set(key(t), t);
  return [...all.values()];
};
export function toggle(
  state: State,
  target: Target,
  fromInputControl = false,
): State {
  if (fromInputControl || state.gesture) return state;
  return {
    ...state,
    selected: contains(state.selected, target)
      ? state.selected.filter((t) => key(t) !== key(target))
      : [...state.selected, target],
  };
}
/** Explicit Open changes inspection only; input widgets do not implicitly open rows. */
export function open(state: State, target: Target): State {
  return { ...state, active: target };
}
export function begin(
  state: State,
  input: {
    point: Point;
    target: Target | null;
    shift: boolean;
    eligible: readonly Target[];
    fromInputControl?: boolean;
    button?: number;
  },
): State {
  if (input.fromInputControl || (input.button ?? 0) !== 0 || state.gesture)
    return state;
  return {
    ...state,
    gesture: {
      origin: { ...input.point },
      target: input.target,
      shift: input.shift,
      baseline: [...state.selected],
      eligible: [...input.eligible],
      mode: "pending",
    },
  };
}
/** Movement threshold distinguishes click from drag; there is no hold timer.
 * Eligible IDs are frozen at pointerdown; newly arriving records cannot enter a gesture.
 * Rows may change as virtualization/scrolling mounts rows from that frozen workset.
 */
export function move(state: State, point: Point, rows: readonly Row[]): State {
  const g = state.gesture;
  if (!g) return state;
  if (
    g.mode === "pending" &&
    Math.hypot(point.x - g.origin.x, point.y - g.origin.y) < 4
  )
    return state;
  if (!g.shift) {
    return {
      ...state,
      gesture: { ...g, mode: "drag" },
      selected: g.target
        ? contains(g.baseline, g.target)
          ? g.baseline
          : [g.target]
        : g.baseline,
    };
  }
  const box = {
    left: Math.min(g.origin.x, point.x),
    right: Math.max(g.origin.x, point.x),
    top: Math.min(g.origin.y, point.y),
    bottom: Math.max(g.origin.y, point.y),
  };
  const touched = rows
    .filter(
      (r) =>
        contains(g.eligible, r.target) &&
        r.left <= box.right &&
        r.right >= box.left &&
        r.top <= box.bottom &&
        r.bottom >= box.top,
    )
    .map((r) => r.target);
  return {
    ...state,
    gesture: { ...g, mode: "rectangle" },
    selected: union(state.selected, touched),
  };
}
export function end(state: State): State {
  const g = state.gesture;
  if (!g) return state;
  const finished = { ...state, gesture: null };
  if (g.mode !== "pending" || !g.target) return finished;
  return g.shift
    ? toggle(finished, g.target)
    : { ...finished, selected: [g.target] };
}
/** pointercancel and unexpected lostpointercapture both use cancel. After end it is a no-op. */
export function cancel(state: State): State {
  return state.gesture
    ? { ...state, selected: state.gesture.baseline, gesture: null }
    : state;
}
/** Only an authoritative deletion/access event removes selection; absence from rows never does. */
export function remove(
  state: State,
  target: Target,
  reason: Removal["reason"],
): State {
  const retain = (items: readonly Target[]) =>
    items.filter((t) => key(t) !== key(target));
  const g = state.gesture;
  return {
    ...state,
    selected: retain(state.selected),
    active:
      state.active && key(state.active) === key(target) ? null : state.active,
    removals: contains(state.selected, target)
      ? [...state.removals, { target, reason }]
      : state.removals,
    gesture: g
      ? {
          ...g,
          baseline: retain(g.baseline),
          eligible: retain(g.eligible),
          target: g.target && key(g.target) === key(target) ? null : g.target,
        }
      : null,
  };
}
/** Modal/menu/dialog handles Escape first. Then gesture cancel, selection clear, inspection close. */
export function escape(state: State, consumedByOverlay = false): State {
  if (consumedByOverlay) return state;
  if (state.gesture) return cancel(state);
  if (state.selected.length) return { ...state, selected: [] };
  return { ...state, active: null };
}
