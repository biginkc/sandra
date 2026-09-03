import { access, mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXPECTED_PROJECT_REF,
  assertDatabaseTarget,
  assertPrivateOutputPath,
  buildManifest,
  parseArgs,
  sha256,
  writePrivatePacket,
} from "../../../scripts/export-sandra-cleanup-packet.mjs";
import {
  EXPECTED_TEST_PROJECT_REF,
  parseRestoreArgs,
  rowsDigest,
} from "../../../scripts/restore-sandra-cleanup-packet.mjs";

describe("Sandra cleanup packet export safeguards", () => {
  it("requires a new output path and accepts an optional environment file", () => {
    expect(
      parseArgs(["--env", "prod.env", "--out", "/private/export"]),
    ).toEqual({ env: "prod.env", out: "/private/export" });
    expect(parseArgs(["--out", "/private/export"])).toEqual({
      out: "/private/export",
    });
    expect(() => parseArgs(["--env", "prod.env"])).toThrow(/Usage/);
    expect(() => parseArgs(["--delete"])).toThrow(/Unknown argument/);
  });

  it("rejects a database URL that is not the exact expected Supabase project", () => {
    expect(() =>
      assertDatabaseTarget(
        `postgresql://postgres.${EXPECTED_TEST_PROJECT_REF}:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres`,
        EXPECTED_PROJECT_REF,
      ),
    ).toThrow(/unexpected database target/i);
    expect(() =>
      assertDatabaseTarget(
        `postgresql://postgres.${EXPECTED_PROJECT_REF}:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres`,
        EXPECTED_PROJECT_REF,
      ),
    ).not.toThrow();
  });

  it("computes generated-time-independent payload and row digests", () => {
    expect(sha256("packet-a")).toBe(
      "f98888d0eafcd658ea28cc8c3dbb00ed3a7fae86bd4b9a9573c83c68a16595ee",
    );
    const packet = {
      format: "sandra-cleanup-packet-v2",
      generatedAt: "first",
      snapshot: { snapshot: "1:2:" },
      target: { projectRef: EXPECTED_PROJECT_REF, orgId: "org" },
      syntheticCohort: { contacts: [], properties: [], leadEvents: [] },
      explicitQaProperties: {
        contacts: [],
        properties: [],
        leadEvents: [],
        tasks: [],
      },
      smokeSequences: { sequences: [], steps: [], enrollments: [] },
      retainedSmokeSequenceToArchive: {
        sequences: [],
        steps: [],
        enrollments: [],
      },
      dependencies: [],
    };
    const first = buildManifest(packet).manifest.stablePayloadSha256;
    const second = buildManifest({
      ...packet,
      generatedAt: "second",
      snapshot: { snapshot: "9:10:" },
    }).manifest.stablePayloadSha256;
    expect(first).toBe(second);
    expect(
      rowsDigest([
        { id: "b", value: 2 },
        { id: "a", value: 1 },
      ]),
    ).toBe(
      rowsDigest([
        { value: 1, id: "a" },
        { value: 2, id: "b" },
      ]),
    );
  });

  it("refuses Git ancestry and symlink components", async () => {
    await expect(
      assertPrivateOutputPath(path.join(process.cwd(), "private-packet")),
    ).rejects.toThrow(/Git worktree/);

    const realTmp = await realpath(tmpdir());
    const root = await mkdtemp(path.join(realTmp, "sandra-export-test-"));
    const destination = path.join(root, "destination");
    await mkdir(destination);
    const linked = path.join(root, "linked");
    await symlink(destination, linked);
    await expect(
      assertPrivateOutputPath(path.join(linked, "packet")),
    ).rejects.toThrow(/symlinked output path/i);
  });

  it("refuses overwrite and removes its own directory after a partial write failure", async () => {
    const realTmp = await realpath(tmpdir());
    const root = await mkdtemp(path.join(realTmp, "sandra-write-test-"));
    const first = path.join(root, "first");
    await writePrivatePacket(first, { "one.json": "{}\n" });
    await expect(
      writePrivatePacket(first, { "one.json": "{}\n" }),
    ).rejects.toThrow(/already exists/i);

    const partial = path.join(root, "partial");
    await expect(
      writePrivatePacket(partial, {
        "one.json": "{}\n",
        "two.json": Symbol("invalid"),
      }),
    ).rejects.toThrow();
    await expect(access(partial)).rejects.toThrow();
  });

  it("keeps the restore verifier test-only and explicit", () => {
    expect(
      parseRestoreArgs([
        "--packet",
        "packet.json",
        "--manifest",
        "manifest.json",
      ]),
    ).toEqual({ packet: "packet.json", manifest: "manifest.json" });
    expect(() => parseRestoreArgs(["--packet", "packet.json"])).toThrow(
      /Usage/,
    );
    expect(() =>
      assertDatabaseTarget(
        `postgresql://postgres.${EXPECTED_PROJECT_REF}:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres`,
        EXPECTED_TEST_PROJECT_REF,
      ),
    ).toThrow(/unexpected database target/i);
  });
});
