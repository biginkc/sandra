import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

/**
 * Search must never change the legacy Prospects behavior: these files stay byte-for-byte what
 * they were on main when the Search branch was cut. (CI also runs the same `git diff`.)
 */
export const LEGACY_FILES = [
  "src/app/(dashboard)/properties/actions.ts",
  "src/app/(dashboard)/properties/dnc-safe-actions.ts",
  "src/app/(dashboard)/properties/promote-leads-actions.ts",
  "src/app/(dashboard)/properties/_actions/count.ts",
  "src/app/(dashboard)/leads/actions.ts",
  "src/app/(dashboard)/campaigns/actions.ts",
  "src/lib/prospects/eligibility.ts",
  "src/lib/messaging/bulk-queue.ts",
  "src/workflows/bulk-sms.ts",
];

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

describe("legacy actions are untouched", () => {
  const base = git("merge-base", "origin/main", "HEAD");

  it.skipIf(!base)("git diff against the merge-base with origin/main is empty for every legacy file", () => {
    const diff = git("diff", "--stat", base!, "--", ...LEGACY_FILES);
    expect(diff, `legacy files changed:\n${diff}`).toBe("");
  });

  it("the legacy list names files that exist", () => {
    for (const f of LEGACY_FILES) expect(() => readFileSync(path.join(root, f), "utf8"), f).not.toThrow();
  });

  it("no legacy file knows about Search (no origin/mode plumbing leaked in)", () => {
    for (const f of LEGACY_FILES) {
      const text = readFileSync(path.join(root, f), "utf8");
      expect(text, f).not.toMatch(/search-scope|lib\/prospects\/select-all|search_properties|QueryOrigin|parseQueryOrigin|enforceCap|searchPage/);
    }
  });
});

const SEARCH_COMPONENTS = [
  "src/app/(dashboard)/properties/prospects-table.tsx",
  "src/app/(dashboard)/properties/bulk-sms-modal.tsx",
  "src/app/(dashboard)/properties/bulk-tag-modal.tsx",
  "src/app/(dashboard)/properties/batch-create-modal.tsx",
  "src/app/(dashboard)/properties/promote-leads-dialog.tsx",
  "src/app/(dashboard)/properties/_components/use-debounced-filters.ts",
];

describe("Search UI uses only the Search entry points", () => {
  it.each(SEARCH_COMPONENTS)("%s imports server actions only from search/actions", (file) => {
    const text = readFileSync(path.join(root, file), "utf8");
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const forbidden = imports.filter((spec) =>
      /(^|\/)(actions|dnc-safe-actions|promote-leads-actions)$|_actions\//.test(spec) && !/search\/actions$/.test(spec),
    );
    expect(forbidden, file).toEqual([]);
  });

  it("the skip-trace dialog's legacy callers keep their unchanged import surface (no search imports)", () => {
    const leadsButton = readFileSync(path.join(root, "src/app/(dashboard)/leads/[id]/skip-trace-button.tsx"), "utf8");
    expect(leadsButton).not.toContain("search/actions");
  });
});
