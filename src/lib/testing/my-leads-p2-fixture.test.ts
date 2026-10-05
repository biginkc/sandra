import { describe, expect, it } from "vitest";

import { CI_DIAL_KEY_REF, CI_DIALPAD_ORIGIN, expireDialIntentCi } from "../../../e2e/support/my-leads-p2-fixture";

describe("my-leads-p2 acceptance fixture additions (pure parts)", () => {
  it("refuses to expire a dial intent outside the disposable ci lane before any query (it disables an evidence guard)", async () => {
    const noDb = { connect: () => { throw new Error("must not connect"); }, query: () => { throw new Error("must not query"); } } as never;
    await expect(expireDialIntentCi(noDb, "00000000-0000-0000-0000-000000000001", {})).rejects.toThrow(/E2E_DISPOSABLE_DATABASE/);
  });

  it("uses the dial-key namespace and origin the dial path accepts", () => {
    expect(CI_DIAL_KEY_REF).toMatch(/^env:DIALPAD_CTI_DIAL_KEY_[A-Z0-9_]{1,120}$/);
    expect(CI_DIALPAD_ORIGIN).toBe("https://dialpad.com");
  });
});
