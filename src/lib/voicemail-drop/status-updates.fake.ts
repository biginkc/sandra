import type { DropPatch, DropRow, DropStatusStore } from "./status-updates";

export type FakeDrop = DropRow & { to_phone: string; queued_at: string } & Omit<DropPatch, "status" | "drop_id">;

/** In-memory DropStatusStore for tests. */
export function createFakeDropStore(drops: FakeDrop[] = []) {
  const events = new Map<string, { status: "processing" | "processed" | "error"; message?: string }>();
  const paused: Array<{ enrollmentId: string; reason: string }> = [];
  const store: DropStatusStore = {
    async findDropById(id) {
      return drops.find((d) => d.id === id) ?? null;
    },
    async findDropsByDropId(dropId) {
      return drops.filter((d) => d.drop_id === dropId);
    },
    async findQueuedDropsByPhone(phone, sinceIso) {
      return drops.filter((d) => d.to_phone === phone && d.status === "queued" && d.queued_at >= sinceIso);
    },
    async updateDrop(id, patch) {
      const drop = drops.find((d) => d.id === id);
      if (drop) Object.assign(drop, patch as Partial<FakeDrop>);
    },
    async pauseEnrollment(enrollmentId, reason) {
      paused.push({ enrollmentId, reason });
    },
    async reserveEvent(eventType, eventId) {
      const key = `${eventType}:${eventId}`;
      const existing = events.get(key);
      if (existing && existing.status !== "error") return "skip";
      events.set(key, { status: "processing" });
      return "reserved";
    },
    async finishEvent(eventType, eventId, outcome, message) {
      events.set(`${eventType}:${eventId}`, { status: outcome, message });
    },
  };
  return { store, drops, events, paused };
}
