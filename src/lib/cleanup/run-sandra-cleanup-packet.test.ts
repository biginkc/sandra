import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PACKETS,
  parseCleanupRunArgs,
  prepareCleanupSql,
} from "../../../scripts/run-sandra-cleanup-packet.mjs";

describe("Sandra cleanup packet runner", () => {
  it("requires a packet-specific exact apply arm", () => {
    expect(parseCleanupRunArgs(["--packet", "a"])).toEqual({
      apply: false,
      packet: "a",
    });
    expect(
      parseCleanupRunArgs([
        "--packet",
        "b",
        `--apply=${PACKETS.b.applyArm}`,
      ]),
    ).toMatchObject({ apply: true, packet: "b" });
    expect(() =>
      parseCleanupRunArgs(["--packet", "a", `--apply=${PACKETS.b.applyArm}`]),
    ).toThrow(/incorrect cleanup apply arm/i);
  });

  it.each(["a", "b"] as const)(
    "pins packet %s bytes and tests the truthful commit transformation",
    (key) => {
      const packet = PACKETS[key];
      const sql = readFileSync(
        join(process.cwd(), "scripts", "sql", packet.file),
        "utf8",
      );
      expect(prepareCleanupSql(sql, packet, false)).toBe(sql);
      const armed = prepareCleanupSql(sql, packet, true);
      expect(armed).toContain("'mode', 'COMMIT_PENDING'");
      expect(armed).not.toContain("'mode', 'ROLLBACK_REHEARSAL'");
      expect(armed.trimEnd().endsWith("commit;")).toBe(true);
      expect(armed.trimEnd().endsWith("rollback;")).toBe(false);
    },
  );

  it("refuses drifted SQL", () => {
    expect(() => prepareCleanupSql("begin; rollback;", PACKETS.a, false)).toThrow(
      /hash does not match/i,
    );
  });
});
