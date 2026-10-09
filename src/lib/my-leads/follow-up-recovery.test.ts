import { describe, expect, it } from "vitest"
import { savedFollowUpGuidance } from "./follow-up-recovery"

describe("saved attempt follow-up guidance", () => {
  it.each(["required", "draft", "failed_not_dispatched"])("offers resume for durable %s work", status => {
    expect(savedFollowUpGuidance({ status, obligationId: "saved-id" })).toContain("resume the saved follow-up")
  })
  it.each(["sending", "unknown", "blocked", "delivery_failed"])("offers review, not another send, for %s", status => {
    const text = savedFollowUpGuidance({ status, obligationId: "saved-id" })
    expect(text).toContain("review the saved follow-up")
    expect(text).not.toContain("resume")
  })
  it.each([null, { status: "required" }, { status: "draft", obligationId: "" }, { status: "blocked", obligationId: "   " }])("does not infer durable work from attempt success: %j", state => {
    const text = savedFollowUpGuidance(state)
    expect(text).toContain("No saved follow-up was confirmed")
    expect(text).toContain("Do not record another attempt")
    expect(text).not.toContain("resume")
  })
})
