import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "scripts/sql/sandra-cleanup-packet-a.sql"),
  "utf8",
);
const accessSql = readFileSync(
  join(process.cwd(), "scripts/sql/sandra-cleanup-packet-b-access.sql"),
  "utf8",
);

describe("Sandra Packet A SQL contract", () => {
  it("is rollback-only by default and cannot silently commit", () => {
    expect(sql.trimEnd().endsWith("rollback;")).toBe(true);
    expect(sql).not.toMatch(/^\s*commit\s*;/imu);
    expect(sql).toContain("'mode', 'ROLLBACK_REHEARSAL'");
  });

  it("pins exact allowlists and excludes retained hidden artifacts", () => {
    expect(sql).toContain("47e4aa8f-274f-438b-b5db-bd21c6958dd8");
    expect(sql).toContain("9693dc11-4a68-4785-ac65-ecdc785d342c");
    expect(sql).toContain("fccef243-c4c9-441a-8bba-563496a91b5e");
    expect(sql).not.toContain("7dfedf79-120a-434b-b417-c920b3227475");
  });

  it("seals sequence provenance and every current foreign-key dependency", () => {
    expect(sql).toContain(
      "fd99eb349c7ed1786f93ae3b4ce80ea5721d1772bb0fac6468bb840131750226",
    );
    expect(sql).toContain(
      "3d0488ce27e858d1b3f685fcc63c3c50b966f486efb34f4ee33a57f3f6bfbd45",
    );
    expect(sql).toContain("pg_constraint");
    expect(sql).toContain(
      "parent.relname=any(array['contacts','properties','sequences'])",
    );
    expect(sql).toContain(
      "property_merges r join packet_a_synthetic_properties x on x.id=r.loser_id",
    );
  });
});

describe("Sandra Packet B access SQL contract", () => {
  it("is separately armed, rollback-only, and membership-only", () => {
    expect(accessSql.trimEnd().endsWith("rollback;")).toBe(true);
    expect(accessSql).not.toMatch(/^\s*commit\s*;/imu);
    expect(accessSql).toContain("delete from public.memberships");
    expect(accessSql).not.toMatch(/delete from auth\.users/iu);
    expect(accessSql).toContain("separate exact-byte Fable approval");
  });

  it("pins the exact four-row manifest and fails on future dependencies", () => {
    expect(accessSql).toContain(
      "4a0d6f2698defab726950fc6cc0fd5f9eed4e76fda236779fb48639a32819ded",
    );
    expect(accessSql).toContain("v_count <> 4");
    expect(accessSql).toContain("parent.relname='memberships'");
    expect(accessSql).toContain("qa_memberships_deleted");
  });
});
