/** Tenant and target kind remain part of identity, including outside the current page. */
export type WorkspaceTarget =
  | { kind: "conversation"; orgId: string; conversationId: string }
  | { kind: "unknown_sender_group"; orgId: string; senderGroupId: string };
export type WorkspaceId = string & { readonly workspaceIdentity: unique symbol };
export const workspaceId = (target: WorkspaceTarget): WorkspaceId => JSON.stringify([
  target.orgId, target.kind, target.kind === "conversation" ? target.conversationId : target.senderGroupId,
]) as WorkspaceId;
export type Point = { x: number; y: number };
export type Bounds = { left: number; top: number; right: number; bottom: number };
export type Gesture = {
  origin: Point; current: Point; pointerId: number; target: WorkspaceId | null;
  shift: boolean; baseline: readonly WorkspaceId[]; eligible: readonly WorkspaceId[];
  selected: readonly WorkspaceId[]; mode: "pending" | "rectangle" | "action";
};
export const toggleSelection = (ids: readonly WorkspaceId[], id: WorkspaceId): WorkspaceId[] =>
  ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
export const rectangle = (a: Point, b: Point): Bounds => ({ left: Math.min(a.x,b.x), top: Math.min(a.y,b.y), right: Math.max(a.x,b.x), bottom: Math.max(a.y,b.y) });
/** Adapted from the reviewed isolated selection proof; never infer database-wide selection. */
export function moveGesture(gesture: Gesture, point: Point, rows: readonly (Bounds & { id: WorkspaceId })[]): Gesture {
  if (gesture.mode === "pending" && Math.hypot(point.x-gesture.origin.x,point.y-gesture.origin.y)<4) return gesture;
  if (!gesture.shift) return { ...gesture, current: point, mode: "action", selected: gesture.target
    ? gesture.baseline.includes(gesture.target) ? gesture.baseline : [gesture.target] : gesture.baseline };
  const box=rectangle(gesture.origin,point);
  const touched=rows.filter((r)=>gesture.eligible.includes(r.id) && r.left<=box.right && r.right>=box.left && r.top<=box.bottom && r.bottom>=box.top).map((r)=>r.id);
  const merged=[...new Set([...gesture.selected,...touched])];
  const selected=merged.length===gesture.selected.length&&merged.every((id,index)=>id===gesture.selected[index])?gesture.selected:merged;
  if(gesture.mode==="rectangle"&&selected===gesture.selected&&point.x===gesture.current.x&&point.y===gesture.current.y)return gesture;
  return { ...gesture, current: point, mode: "rectangle", selected };
}
export function finishGesture(g: Gesture): readonly WorkspaceId[] {
  if(g.mode!=="pending" || !g.target) return g.selected;
  return g.shift ? toggleSelection(g.baseline,g.target) : [g.target];
}
