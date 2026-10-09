import { describe, expect, it } from "vitest"
import { finalizesExistingAttempt } from "./attempt-command"
describe("attempt command identity", () => {
  it.each(["sandra", "dialpad"])("finalizes a linked %s call", source => {
    expect(finalizesExistingAttempt({ source, callActivityId: "call-1" })).toBe(true)
  })
  it.each([null, undefined, "", "   "])("logs an unlinked DialPad call (%s)", callActivityId => {
    expect(finalizesExistingAttempt({ source: "dialpad", callActivityId })).toBe(false)
  })
  it("does not link manual outreach to a hidden prior selection", () => {
    expect(finalizesExistingAttempt({ source: "manual", callActivityId: "call-1" })).toBe(false)
  })
})
