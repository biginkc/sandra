import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertPrivateOutputPath,
  parseArgs,
  sha256,
} from "../../../scripts/export-sandra-cleanup-packet.mjs";

describe("Sandra cleanup packet export safeguards", () => {
  it("requires explicit environment and output paths", () => {
    expect(
      parseArgs(["--env", "prod.env", "--out", "/private/export"]),
    ).toEqual({ env: "prod.env", out: "/private/export" });
    expect(() => parseArgs(["--env", "prod.env"])).toThrow(/Usage/);
    expect(() => parseArgs(["--delete"])).toThrow(/Unknown argument/);
  });

  it("computes stable SHA-256 digests", () => {
    expect(sha256("packet-a")).toBe(
      "f98888d0eafcd658ea28cc8c3dbb00ed3a7fae86bd4b9a9573c83c68a16595ee",
    );
  });

  it("refuses any output directory nested inside a Git worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sandra-export-test-"));
    await mkdir(path.join(root, ".git"));
    await expect(
      assertPrivateOutputPath(path.join(root, "private")),
    ).rejects.toThrow(/Git worktree/);
  });
});
