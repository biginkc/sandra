import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), onSent: null as null | (() => void) }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock("../../my-leads/rep-sms-composer", () => ({
  RepSmsComposer: ({ onSent }: { onSent?: () => void }) => {
    mocks.onSent = onSent ?? null
    return <button type="button" onClick={() => onSent?.()}>Simulate sent SMS</button>
  },
}))

import { LeadRepSmsComposer } from "./rep-sms-composer"

describe("LeadRepSmsComposer", () => {
  beforeEach(() => {
    mocks.refresh.mockReset()
    mocks.onSent = null
  })

  it("refreshes the lead route after a resumed SMS is confirmed", async () => {
    const user = userEvent.setup()
    render(<LeadRepSmsComposer propertyId="property-1" replyToPhone="+18165550123" />)
    expect(mocks.onSent).toEqual(expect.any(Function))
    await user.click(screen.getByRole("button", { name: "Simulate sent SMS" }))
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})
