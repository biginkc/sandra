import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const acceptance = new URL("./", import.meta.url);

async function text(relative) {
  return readFile(new URL(relative, acceptance), "utf8");
}

test("acceptance specs cannot reintroduce truncate cleanup", async () => {
  const specs = [
    "inbox.spec.ts",
    "individual-workflows.spec.ts",
    "navigation-selection.spec.ts",
    "outbox.spec.ts",
    "reviewed-replies.spec.ts",
    "unknown-bulk.spec.ts",
  ];
  for (const spec of specs) {
    const source = await text(spec);
    assert.doesNotMatch(
      source,
      /\bresetTenantTables\b/,
      `${spec} must use resetAcceptanceFixture, never the TRUNCATE RPC`,
    );
    assert.match(source, /resetAcceptanceFixture/);
  }
});

test("cleanup requires source deletion plus a meaningful private projection drain", async () => {
  const source = await text("cleanup.ts");
  assert.match(source, /deleteOrgScopedFixtureRows\(admin, orgId\)/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /inbox_maintained\.queue/);
  assert.match(source, /inbox_parent\.work/);
  assert.match(source, /inbox_safety\.routes/);
  assert.match(source, /inbox_bridge\.summaries/);
  assert.match(source, /inbox_bridge\.filter_rows/);
  assert.match(source, /decodeAcceptanceProjectionState/);
  assert.match(source, /isAcceptanceProjectionDrained/);
  assert.match(source, /const probe = await openProjectionProbe\(\);[\s\S]*?deleteOrgScopedFixtureRows/);
  assert.doesNotMatch(source, /seed(?:Sender|ProviderCampaign)Catalog/);
  assert.doesNotMatch(source, /\.rpc\(["']reset_tenant_tables/);
});

test("the helper does not broaden the cleanup org scope", async () => {
  const source = await text("cleanup.ts");
  assert.match(source, /orgId: string = DEFAULT_ORG_ID/);
  assert.match(source, /deleteOrgScopedFixtureRows\(admin, orgId\)/);
  assert.match(source, /countOrgScopedFixtureRows\(admin, orgId\)/);
  assert.doesNotMatch(source, /\.from\(["']inbox_/);
});

// Keep this module's root URL referenced so accidental path changes fail at
// module load rather than silently reading a sibling worktree.
assert.equal(new URL("e2e/inbox-acceptance/", root).pathname, acceptance.pathname);
