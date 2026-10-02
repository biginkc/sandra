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
});
