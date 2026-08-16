import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wizard reviewed-dataset upload contract", () => {
  it("uploads the serialized reviewed File and never the original state.file", () => {
    // This is an intentional wiring regression guard. The pure serializer is
    // tested in dataset.test.ts; this assertion proves the wizard actually
    // passes its output to Storage, which is the exact divergence the old
    // preset path had.
    const source = readFileSync(new URL("./wizard.tsx", import.meta.url), "utf8");
    expect(source).toContain("const reviewedDataset = await buildReviewedDatasetFile");
    expect(source).toContain("uploadCsvToStorage(reviewedDataset.file)");
    expect(source).not.toMatch(/uploadCsvToStorage\(state\.file/);
  });
});
