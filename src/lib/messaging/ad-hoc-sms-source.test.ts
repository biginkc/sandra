import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AD_HOC_BULK_SMS_SOURCE } from "./ad-hoc-sms-source";

const root = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("ad-hoc bulk SMS source literal", () => {
  it("equals the literal the campaign creator stamps and the legacy workflow reads", () => {
    const creator = read("src/lib/campaigns/ad-hoc-bulk-sms.ts");
    const workflow = read("src/workflows/bulk-sms.ts");
    expect(creator).toContain(`source: "${AD_HOC_BULK_SMS_SOURCE}"`);
    expect(workflow).toContain(`source?: unknown }).source === "${AD_HOC_BULK_SMS_SOURCE}"`);
  });

  it("the Search workflow uses this constant, not its own copy", () => {
    const search = read("src/workflows/search-bulk-sms.ts");
    expect(search).toContain('from "@/lib/messaging/ad-hoc-sms-source"');
    expect(search).not.toMatch(/"bulk_sms_modal"/);
  });

  it("also matches origin/main's text (not just this branch's files)", () => {
    const fromMain = (file: string): string | null => {
      try {
        return execFileSync("git", ["show", `origin/main:${file}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null; // no origin/main in this checkout: the branch-file assertions above still apply
      }
    };
    const creator = fromMain("src/lib/campaigns/ad-hoc-bulk-sms.ts");
    const workflow = fromMain("src/workflows/bulk-sms.ts");
    if (creator === null || workflow === null) return;
    expect(creator).toContain(`source: "${AD_HOC_BULK_SMS_SOURCE}"`);
    expect(workflow).toContain(`"${AD_HOC_BULK_SMS_SOURCE}"`);
  });
});
