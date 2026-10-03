// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SignOutForm } from "./sign-out-form"
import { beginSend, claimSubmission, endSend, getEpoch, listSubmissions, resetSubmissionStoreForTests } from "@/app/(dashboard)/my-leads/_components/submission-store"

const record = { viewerUserId: "u1", orgId: "o1", memberId: "m1", propertyId: "p1", assignmentEpisodeId: "e1", operation: "log_attempt", key: "k1", route: "log_attempt", status: "uncertain" as const, createdAt: Date.now(), payload: { note: "n" } }

describe("SignOutForm", () => {
  beforeEach(() => { resetSubmissionStoreForTests() })
  afterEach(() => { vi.restoreAllMocks() })

  it("with nothing pending, signs out without asking and clears the store (epoch bumped)", () => {
    const confirm = vi.spyOn(window, "confirm")
    claimSubmission({ ...record, status: "committed" }, "t", { epoch: getEpoch() })
    const epoch = getEpoch()
    render(<SignOutForm />)
    const form = screen.getByRole("button", { name: "Sign out" }).closest("form")!
    form.addEventListener("submit", (event) => event.preventDefault())
    fireEvent.submit(form)
    expect(confirm).not.toHaveBeenCalled()
    expect(getEpoch()).toBeGreaterThan(epoch)
    expect(listSubmissions(record, () => true)).toEqual([])
  })

  it("with a save pending it asks first; declining keeps the user signed in and the record protected", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    claimSubmission(record, "t", { epoch: getEpoch(), send: true })
    beginSend()
    render(<SignOutForm />)
    const form = screen.getByRole("button", { name: "Sign out" }).closest("form")!
    const submitted = fireEvent.submit(form)
    expect(confirm).toHaveBeenCalledWith("A save may still be going through. Sign out anyway?")
    expect(submitted).toBe(false) // default prevented
    expect(listSubmissions(record, () => true)).toHaveLength(1)
    endSend()
  })

  it("confirming signs out anyway (accepted trade-off: the protection is dropped)", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    claimSubmission(record, "t", { epoch: getEpoch(), send: true })
    render(<SignOutForm />)
    const form = screen.getByRole("button", { name: "Sign out" }).closest("form")!
    form.addEventListener("submit", (event) => event.preventDefault())
    fireEvent.submit(form)
    expect(listSubmissions(record, () => true)).toEqual([])
  })
})
