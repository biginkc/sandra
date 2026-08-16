import { describe, it, expect } from "vitest";

import { indicatorOrder } from "./wizard";

describe("indicatorOrder (visual step list)", () => {
  it("returns [] on the Mode step regardless of mode (indicator hidden)", () => {
    expect(indicatorOrder("mode", null)).toEqual([]);
    expect(indicatorOrder("mode", "add")).toEqual([]);
    expect(indicatorOrder("mode", "update")).toEqual([]);
  });

  it("renders Add-flow steps (sans Mode) once user advances past Mode — first visible step is Upload at index 0", () => {
    const steps = indicatorOrder("upload", "add");
    expect(steps).toEqual(["upload", "preflight", "map", "review", "services", "confirm", "progress"]);
    expect(steps[0]).toBe("upload"); // Upload now displays as "1"
  });

  it("renders Update-flow steps (sans Mode) once user advances — first visible step is the suboperation picker", () => {
    const steps = indicatorOrder("suboperation", "update");
    expect(steps).toEqual([
      "suboperation",
      "update-upload",
      "preview-update",
      "progress",
    ]);
    expect(steps[0]).toBe("suboperation"); // 'What to update' displays as "1"
  });

  it("keeps the approved display order on later Add steps", () => {
    const steps = indicatorOrder("review", "add");
    expect(steps.indexOf("upload")).toBe(0); // 1
    expect(steps.indexOf("preflight")).toBe(1); // 2
    expect(steps.indexOf("map")).toBe(2); // 3
    expect(steps.indexOf("review")).toBe(3); // 4 (active)
  });

  it("keeps the same display order on later Update steps so the user always sees a consistent post-Mode list", () => {
    expect(indicatorOrder("preview-update", "update")).toEqual([
      "suboperation",
      "update-upload",
      "preview-update",
      "progress",
    ]);
  });

  it("never includes 'mode' in any non-Mode display order", () => {
    for (const mode of [null, "add", "update"] as const) {
      for (const step of [
        "upload",
        "preflight",
        "map",
        "review",
        "services",
        "confirm",
        "progress",
        "suboperation",
        "update-upload",
        "preview-update",
      ] as const) {
        expect(indicatorOrder(step, mode)).not.toContain("mode");
      }
    }
  });
});
