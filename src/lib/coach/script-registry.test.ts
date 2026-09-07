import { describe, expect, it } from "vitest";
import { COACH_SCRIPTS } from "./script-registry";
import script from "./closr-script-v0.json";

describe("coach script registry", () => {
  it("exposes the existing script metadata without a separate version or title", () => {
    expect(COACH_SCRIPTS).toEqual([{ id: "closr-outbound", title: script.title, version: script.version }]);
  });
});
