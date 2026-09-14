import { describe, it, expect } from "vitest";
import {
  historyMoney,
  safeHistoryRecording,
  mergeAcquisitionHistory,
  type AcquisitionHistoryFact,
} from "./acquisition-history";
describe("acquisition history facts", () => {
  it("preserves cents beyond JavaScript safe integer precision", () => {
    expect(historyMoney("12500050")).toBe("$125,000.50");
    expect(historyMoney("9223372036854775807")).toBe(
      "$92,233,720,368,547,758.07",
    );
  });
  it("refuses executable and credential-bearing recordings", () => {
    for (const url of [
      "javascript:alert(1)",
      "https://secret:pass@example.com/x",
      "data:text/plain,hello",
      "invalid",
    ])
      expect(safeHistoryRecording(url)).toBeNull();
    expect(safeHistoryRecording("https://example.com/recording")).toBe(
      "https://example.com/recording",
    );
  });
  it("merges repeated pages by fact kind and ID, retaining later outcome", () => {
    const a = {
      id: "a",
      kind: "offer",
      outcome: "pending",
    } as AcquisitionHistoryFact;
    const b = { ...a, outcome: "declined" } as AcquisitionHistoryFact;
    expect(mergeAcquisitionHistory([a], [b])).toEqual([b]);
  });
});
