import { describe, expect, it } from "vitest";

import { withoutDncLocked } from "./dnc-locked";
import { fakePostgrest } from "./fake-postgrest.test-util";
import type { OpenHold, RunWithSteps } from "./types";

const hold = (id: string, property_id: string | null = id): OpenHold<RunWithSteps> => ({
  id, property_id, conversation_id: null, sources: ["needs_attention"], since: null, reason: "r", run: null,
});
const props = (locked: string[]) => ["a", "b", "c", "x"].map((id) => ({ id, org_id: "org", is_dnc_locked: locked.includes(id) }));

describe("withoutDncLocked", () => {
  it("drops holds on permanently do-not-contact locked properties and keeps the rest", async () => {
    const out = await withoutDncLocked(fakePostgrest({ properties: props(["b"]) }).client, "org", [hold("a"), hold("b"), hold("c")]);
    expect(out?.map((h) => h.id)).toEqual(["a", "c"]);
  });
  it("still finds every locked id under a 1-row server cap (it never fails open)", async () => {
    const out = await withoutDncLocked(fakePostgrest({ properties: props(["a", "b"]) }, { cap: 1 }).client, "org", [hold("a"), hold("b"), hold("c")]);
    expect(out?.map((h) => h.id)).toEqual(["c"]);
  });
  it("keeps holds with no property (nothing to look up)", async () => {
    const out = await withoutDncLocked(fakePostgrest({ properties: props(["a"]) }).client, "org", [hold("x", null)]);
    expect(out).toHaveLength(1);
  });
  it("FAILS CLOSED when the lookup fails: null, so the caller renders an error and no cards", async () => {
    const out = await withoutDncLocked(fakePostgrest({ properties: props(["a"]) }, { fail: () => true }).client, "org", [hold("a"), hold("b")]);
    expect(out).toBeNull();
  });
});
