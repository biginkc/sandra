import { StrictMode, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({ submitMyLeadCommand: vi.fn(), submitMyLeadHandoffDrip: vi.fn() }))
vi.mock("../actions", () => ({ submitMyLeadCommand: actions.submitMyLeadCommand, submitMyLeadHandoffDrip: actions.submitMyLeadHandoffDrip }))

import type { QueueRow } from "@/lib/my-leads/queries"
import { useAttemptWorkflow, type AttemptOpening } from "./use-attempt-workflow"
import { SignOutForm } from "@/components/sign-out-form"
import { fireEvent, render, screen } from "@testing-library/react"
import { SUBMISSION_STORAGE_KEY, clearAllSubmissions, getEpoch, simulateReloadForTests, getSubmission, listSubmissions, resetSubmissionStoreForTests } from "./submission-store"

/**
 * Store epoch + per-record CAS (spec v3). Every test drives the REAL hook against a fake of the command
 * SQL (receipt lookup first, then STALE_*, then commit) that can commit the original while dropping its
 * response, and counts commits.
 */
const A = { userId: "user-1", orgId: "org-1" }
const B = { userId: "user-2", orgId: "org-1" }
const row = (queueVersion = 3) => ({ propertyId: "p1", assignmentEpisodeId: "ep-1", queueVersion, sharedStatus: "new_lead", address: "1 Main", offer: null }) as unknown as QueueRow
const opening = (action: AttemptOpening["action"] = "log-attempt", version = 3): AttemptOpening => ({ action, row: row(version) })
const scope = (viewer = A) => ({ viewerUserId: viewer.userId, orgId: viewer.orgId, memberId: "rep-A", propertyId: "p1", assignmentEpisodeId: "ep-1" })
const typed = { outcome: "reached", source: "dialpad", note: "typed" }

type Props = { current: AttemptOpening | null; viewer?: typeof A }
function setup(initial: AttemptOpening | null, options: { viewer?: typeof A; strict?: boolean; saveTimeoutMs?: number } = {}) {
  const handlers = { readRow: vi.fn(async (): Promise<QueueRow | null> => row()), onCommitted: vi.fn(async (...args: unknown[]) => { void args }), onSettled: vi.fn(), onReconciled: vi.fn(async () => undefined), onClose: vi.fn(), onDripChanged: vi.fn() }
  const wrapper = options.strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined
  const hook = renderHook(({ current, viewer }: Props) => useAttemptWorkflow({ opening: current, memberId: "rep-A", viewer: viewer ?? options.viewer ?? A, saveTimeoutMs: options.saveTimeoutMs, ...handlers }),
    { initialProps: { current: initial } as Props, wrapper })
  return { hook, handlers }
}
type Hook = ReturnType<typeof setup>["hook"]
const sent = (call = 0) => actions.submitMyLeadCommand.mock.calls[call][1] as Record<string, unknown>
const gateOf = () => { let open: () => void = () => undefined; const promise = new Promise<void>((resolve) => { open = resolve }); return { promise, open } }
const startSave = (hook: Hook, payload: object = typed) => {
  let pending: Promise<unknown> = Promise.resolve()
  act(() => { pending = hook.result.current.submit(payload).catch((error: unknown) => error) })
  return () => act(async () => { await pending })
}
const save = async (hook: Hook, payload: object = typed) => { let out: unknown; await act(async () => { out = await hook.result.current.submit(payload).catch((error: unknown) => error) }); return out as { ok?: boolean; message?: string } }

function fakeServer(version = 3) {
  const db = { version, receipts: new Map<string, string>(), commits: 0 }
  const inflight: Record<string, unknown>[] = []
  const hashOf = (input: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(input).filter(([k]) => k !== "idempotencyKey").sort(([a], [b]) => a.localeCompare(b))))
  const execute = (input: Record<string, unknown>) => {
    const key = String(input.idempotencyKey)
    const hash = hashOf(input)
    const stored = db.receipts.get(key)
    if (stored !== undefined) return stored === hash ? { ok: true, duplicate: true } : { ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." }
    if (input.source !== "sandra" && input.expectedQueueVersion !== db.version) return { ok: false, answered: true, certainty: "rejected", code: "STALE_STATE", message: "stale" }
    db.receipts.set(key, hash)
    db.version += 1
    db.commits += 1
    return { ok: true }
  }
  return { db, execute, queue: (input: Record<string, unknown>) => { inflight.push(input) }, land: () => { for (const input of inflight.splice(0)) execute(input) } }
}
const stale = { ok: false, answered: true, certainty: "rejected", code: "STALE_STATE", message: "stale" }

describe("store epoch and per-record CAS", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    resetSubmissionStoreForTests()
    for (const fn of Object.values(actions)) fn.mockReset()
  })

  it("Astra 1: a delayed STALE to the OLD instance after remount, replay, Start over and a lost v4 is refused; the store keeps uncertain/v4 on the same key; at most 1 commit", async () => {
    const server = fakeServer(3)
    const oldGate = gateOf()
    let calls = 0
    actions.submitMyLeadCommand.mockImplementation(async (_command: string, input: Record<string, unknown>) => {
      calls += 1
      if (calls === 1) { await oldGate.promise; return stale } // the old instance's request: its answer is delayed
      if (input.expectedQueueVersion === 4) { server.queue(input); throw new Error("network") } // v4 lost in flight
      return server.execute(input)
    })
    const old = setup(opening())
    const finishOld = startSave(old.hook) // v3, pending
    old.hook.unmount()
    const fresh = setup(opening()) // remount: resumes the unresolved record with its payload
    expect(fresh.hook.result.current.recoveryValue?.reconciliation).toBeDefined()
    server.db.version = 4 // another writer moved the lead; v3 never ran
    await save(fresh.hook) // frozen replay (send #2): STALE, proof
    fresh.handlers.readRow.mockResolvedValue(row(4))
    await act(async () => { fresh.hook.result.current.recoveryValue?.refresh() })
    act(() => fresh.hook.result.current.recoveryValue?.startOver?.())
    await save(fresh.hook, { ...typed, note: "edited v4" }) // v4: lost in flight, uncertain
    const key = getSubmission({ ...scope(), operation: "log_attempt" })!.key
    expect(getSubmission({ ...scope(), operation: "log_attempt" })).toMatchObject({ status: "uncertain", expectedQueueVersion: 4 })
    oldGate.open() // the old instance's delayed STALE arrives now
    await finishOld()
    const record = getSubmission({ ...scope(), operation: "log_attempt" })
    expect(record).toMatchObject({ status: "uncertain", expectedQueueVersion: 4, key }) // never back to fresh/v3
    // Reopen resumes the same key; the delayed v4 lands; the re-save is a duplicate.
    fresh.hook.unmount()
    const reopened = setup({ action: "log-attempt", row: row(4) })
    server.land()
    await save(reopened.hook, { ...typed, note: "edited v4" })
    expect(sent(calls - 1).idempotencyKey).toBe(key)
    expect(server.db.commits).toBe(1)
  })

  it("Astra 2: after sign-out, a pending transport failure and an unmounted hook's write leave the store empty (memory and sessionStorage); the in-flight request commits once", async () => {
    const server = fakeServer(3)
    const gate = gateOf()
    actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => { await gate.promise; server.queue(input); throw new Error("network") })
    const { hook } = setup(opening())
    const finish = startSave(hook)
    hook.unmount() // the hook is gone but its request is not
    clearAllSubmissions() // sign-out
    gate.open()
    await finish()
    server.land()
    expect(listSubmissions(scope(), () => true)).toEqual([])
    expect(window.sessionStorage.getItem(SUBMISSION_STORAGE_KEY)).toBeNull()
    expect(server.db.commits).toBe(1)
  })

  it("Astra 2 (viewer purge): a viewer switch purges the old viewer's record; a late failure from the old viewer writes nothing under either; 1 commit per viewer", async () => {
    const server = fakeServer(3)
    const gate = gateOf()
    actions.submitMyLeadCommand.mockImplementationOnce(async (_c: string, input: Record<string, unknown>) => { await gate.promise; server.queue(input); throw new Error("network") })
      .mockImplementation(async (_c: string, input: Record<string, unknown>) => server.execute(input))
    const a = setup(opening(), { viewer: A })
    const finish = startSave(a.hook)
    const epoch = getEpoch()
    const b = setup(opening(), { viewer: B }) // a different viewer takes over this browser
    expect(getEpoch()).toBeGreaterThan(epoch)
    gate.open()
    await finish()
    server.land() // viewer A's request commits for A only
    expect(listSubmissions(scope(A), () => true)).toEqual([])
    expect(listSubmissions(scope(B), () => true)).toEqual([])
    expect(b.hook.result.current.recoveryValue).toBeNull()
    expect(server.db.commits).toBe(1)
    server.db.version = 3
    const out = await save(b.hook, typed)
    expect(out.ok).toBe(true)
    expect(server.db.commits).toBe(2) // one per viewer
  })

  it("two hosts of the same record: the last claimer owns it; the other's late write is refused and it re-reads; same key; 1 commit", async () => {
    const server = fakeServer(3)
    const gate1 = gateOf()
    const gate2 = gateOf()
    let calls = 0
    actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => {
      calls += 1
      if (calls === 1) { await gate1.promise; throw new Error("network") } // My Leads: lost
      await gate2.promise
      return server.execute(input)
    })
    const myLeads = setup(opening())
    const finish1 = startSave(myLeads.hook)
    const leadPage = setup(opening()) // the lead page resumes the same record
    const finish2 = startSave(leadPage.hook) // and claims it with the replay
    gate1.open()
    await finish1() // My Leads' late transport failure: refused
    expect(myLeads.handlers.onCommitted).not.toHaveBeenCalled()
    gate2.open()
    await finish2()
    expect(leadPage.handlers.onCommitted).toHaveBeenCalledTimes(1)
    expect(sent(1).idempotencyKey).toBe(sent(0).idempotencyKey)
    expect(server.db.commits).toBe(1)
  })

  it("StrictMode double mount claims nothing, bumps no epoch and leaves one record; 1 commit", async () => {
    const server = fakeServer(3)
    actions.submitMyLeadCommand.mockImplementationOnce(async (_c: string, input: Record<string, unknown>) => { server.execute(input); throw new Error("network") })
      .mockImplementation(async (_c: string, input: Record<string, unknown>) => server.execute(input))
    const first = setup(opening(), { strict: true })
    const epoch = getEpoch()
    await save(first.hook)
    first.hook.unmount()
    const second = setup(opening(), { strict: true })
    expect(getEpoch()).toBe(epoch)
    expect(listSubmissions(scope(), () => true)).toHaveLength(1)
    await save(second.hook)
    expect(server.db.commits).toBe(1)
  })

  describe("late answers on a SUPERSEDED instance are refused (the owner's replay resolves the record)", () => {
    async function superseded(lateAnswer: () => Promise<unknown>) {
      const server = fakeServer(3)
      const gate1 = gateOf()
      const gate2 = gateOf()
      let calls = 0
      actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => {
        calls += 1
        if (calls === 1) { await gate1.promise; return lateAnswer() }
        await gate2.promise
        return server.execute(input)
      })
      const old = setup(opening())
      const finishOld = startSave(old.hook)
      old.hook.unmount()
      const owner = setup(opening())
      const finishOwner = startSave(owner.hook) // the replay claims the record
      gate1.open()
      await finishOld()
      const mid = getSubmission({ ...scope(), operation: "log_attempt" })
      gate2.open()
      await finishOwner()
      return { server, old, owner, mid }
    }
    it("late ok: refused, no host callback, the record stays uncertain; the owner's replay gets the stored result; 1 commit", async () => {
      const server0 = { ran: false }
      const { server, old, owner, mid } = await superseded(async () => { server0.ran = true; return { ok: true } })
      expect(old.handlers.onCommitted).not.toHaveBeenCalled()
      expect(mid).toMatchObject({ status: "uncertain" })
      expect(owner.handlers.onCommitted).toHaveBeenCalledTimes(1)
      expect(server.db.commits).toBe(1)
    })
    it("late STALE: refused, the record never goes back to fresh; 1 commit", async () => {
      const { server, mid } = await superseded(async () => stale)
      expect(mid).toMatchObject({ status: "uncertain" })
      expect(server.db.commits).toBe(1)
    })
    it("late transport failure: refused; 1 commit", async () => {
      const { server, old, mid } = await superseded(async () => { throw new Error("network") })
      expect(mid).toMatchObject({ status: "uncertain" })
      expect(old.handlers.onCommitted).not.toHaveBeenCalled()
      expect(server.db.commits).toBe(1)
    })
    it("a superseded instance answers with a neutral non-ok result, never a raw ok", async () => {
      const gate1 = gateOf()
      const gate2 = gateOf()
      let calls = 0
      actions.submitMyLeadCommand.mockImplementation(async () => { calls += 1; await (calls === 1 ? gate1 : gate2).promise; return { ok: true } })
      const old = setup(opening())
      let result: unknown
      act(() => { void old.hook.result.current.submit(typed).then((r) => { result = r }) })
      old.hook.unmount()
      const owner = setup(opening())
      const finishOwner = startSave(owner.hook)
      gate1.open()
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(result).toMatchObject({ ok: false })
      gate2.open()
      await finishOwner()
    })
  })

  describe("an UNMOUNTED instance that is still the owner may finish", () => {
    it("ok writes committed-not-seen (a success nobody saw), never a silent clear", async () => {
      const server = fakeServer(3)
      const gate = gateOf()
      actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => { await gate.promise; return server.execute(input) })
      const { hook } = setup(opening("log-offer"))
      const finish = startSave(hook, { amountCents: 1 })
      hook.unmount()
      gate.open()
      await finish()
      expect(getSubmission({ ...scope(), operation: "log-offer" })).toMatchObject({ status: "committed-not-seen" })
      expect(server.db.commits).toBe(1)
    })
    it("STALE on its only send returns the record to fresh", async () => {
      const server = fakeServer(3)
      server.db.version = 9
      const gate = gateOf()
      actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => { await gate.promise; return server.execute(input) })
      const { hook } = setup(opening())
      const finish = startSave(hook)
      hook.unmount()
      gate.open()
      await finish()
      expect(getSubmission({ ...scope(), operation: "log_attempt" })).toMatchObject({ status: "fresh" })
      expect(server.db.commits).toBe(0)
    })
    it("a transport failure leaves it uncertain; the replay is a duplicate; 1 commit", async () => {
      const server = fakeServer(3)
      const gate = gateOf()
      actions.submitMyLeadCommand.mockImplementationOnce(async (_c: string, input: Record<string, unknown>) => { await gate.promise; server.execute(input); throw new Error("network") })
        .mockImplementation(async (_c: string, input: Record<string, unknown>) => server.execute(input))
      const { hook } = setup(opening())
      const finish = startSave(hook)
      hook.unmount()
      gate.open()
      await finish()
      expect(getSubmission({ ...scope(), operation: "log_attempt" })).toMatchObject({ status: "uncertain" })
      const again = setup(opening())
      await save(again.hook)
      expect(server.db.commits).toBe(1)
    })
  })

  it("timeout, then a late answer: uncertain is written once and the late answer is ignored; the replay is a duplicate; 1 commit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const server = fakeServer(3)
      const gate = gateOf()
      actions.submitMyLeadCommand.mockImplementationOnce(async (_c: string, input: Record<string, unknown>) => { await gate.promise; return server.execute(input) })
        .mockImplementation(async (_c: string, input: Record<string, unknown>) => server.execute(input))
      const { hook, handlers } = setup(opening(), { saveTimeoutMs: 1000 })
      let pending: Promise<unknown> = Promise.resolve()
      act(() => { pending = hook.result.current.submit(typed).catch((error: unknown) => error) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1001); await pending })
      const marked = getSubmission({ ...scope(), operation: "log_attempt" })
      expect(marked).toMatchObject({ status: "uncertain" })
      gate.open() // the late answer: ok, after the timeout
      await act(async () => { await Promise.resolve() })
      expect(handlers.onCommitted).not.toHaveBeenCalled()
      expect(getSubmission({ ...scope(), operation: "log_attempt" })).toMatchObject({ status: "uncertain", rev: marked?.rev })
      await save(hook)
      expect(handlers.onCommitted).toHaveBeenCalledTimes(1)
      expect(server.db.commits).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it("the missing piece is named: no viewer or organization versus no assigned rep", async () => {
    const handlers = { readRow: vi.fn(async () => row()), onCommitted: vi.fn(async () => undefined), onSettled: vi.fn(), onClose: vi.fn(), onDripChanged: vi.fn() }
    const noViewer = renderHook(() => useAttemptWorkflow({ opening: opening(), memberId: "rep-A", viewer: null, ...handlers }))
    const noRep = renderHook(() => useAttemptWorkflow({ opening: opening(), memberId: null, viewer: A, ...handlers }))
    let first: { message?: string } | undefined
    let second: { message?: string } | undefined
    await act(async () => { first = await noViewer.result.current.submit(typed) as { message?: string } })
    await act(async () => { second = await noRep.result.current.submit(typed) as { message?: string } })
    expect(first?.message).toMatch(/active organization/)
    expect(second?.message).toMatch(/no assigned rep/)
    expect(actions.submitMyLeadCommand).not.toHaveBeenCalled()
  })

  it("a frozen replay refused for access reasons says the save is held and the way out is Cancel", async () => {
    const server = fakeServer(3)
    actions.submitMyLeadCommand.mockImplementationOnce(async (_c: string, input: Record<string, unknown>) => { server.execute(input); throw new Error("network") })
      .mockResolvedValueOnce({ ok: false, answered: true, certainty: "unknown", code: "FORBIDDEN", message: "This lead is unavailable or you no longer have access." })
    const { hook } = setup(opening())
    await save(hook)
    await save(hook)
    expect(hook.result.current.recoveryValue?.message).toMatch(/This save is held\. Cancel to leave it; it expires after 24 hours\./)
    expect(server.db.commits).toBe(1)
  })

  it("claims compare-and-set: a stale instance cannot move already-saved back to uncertain; it is refused, re-reads, and a fresh read then claim succeeds", async () => {
    actions.submitMyLeadCommand
      .mockRejectedValueOnce(new Error("network")) // W: the original is lost, uncertain
      .mockResolvedValueOnce({ ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." }) // Y: conflict
    const w = setup(opening())
    await save(w.hook)
    w.hook.unmount()
    const x = setup(opening()) // reads the uncertain record at its current revision
    const y = setup(opening()) // reads the same revision
    await save(y.hook) // Y claims first and moves the record to already-saved
    expect(getSubmission({ ...scope(), operation: "log_attempt" })).toMatchObject({ status: "already-saved" })
    const calls = actions.submitMyLeadCommand.mock.calls.length
    const out = await save(x.hook) // X's claim carries the revision it read: refused
    expect(out.ok).toBe(false)
    expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(calls) // nothing was sent
    expect(getSubmission({ ...scope(), operation: "log_attempt" })).toMatchObject({ status: "already-saved" })
    // X re-read the store and shows the current state; the user must act again.
    expect(x.hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "This was already saved. Refresh to see it." })
    await act(async () => { x.hook.result.current.recoveryValue?.refresh() }) // a fresh read, then a claim: succeeds
    expect(x.handlers.onClose).toHaveBeenCalledTimes(1)
    expect(listSubmissions(scope(), () => true)).toEqual([])
  })

  it("claims compare-and-set: an instance that reads the current revision AFTER another moved the record can claim it", async () => {
    actions.submitMyLeadCommand
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." })
    const w = setup(opening())
    await save(w.hook)
    w.hook.unmount()
    const y = setup(opening())
    await save(y.hook) // moves the record to already-saved
    const late = setup(opening()) // reads the current revision
    expect(late.hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "This was already saved. Refresh to see it." })
    await act(async () => { late.hook.result.current.recoveryValue?.refresh() })
    expect(late.handlers.onClose).toHaveBeenCalledTimes(1)
    expect(listSubmissions(scope(), () => true)).toEqual([])
  })

  describe("v4: no silent re-key (committed-not-seen, held-a-record, persisted pending)", () => {
    it("Astra P1: a delayed ok after unmount and reopen is written committed-not-seen; Reconcile is refused with no send; Saved earlier, Refresh clears; 1 commit; the next opening is a legit new save", async () => {
      const server = fakeServer(3)
      const gate = gateOf()
      actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => {
        const result = server.execute(input) // the server commits at once
        await gate.promise // but the answer is delayed
        return result
      })
      const old = setup(opening())
      const finishOld = startSave(old.hook)
      old.hook.unmount()
      const reopened = setup(opening("log-attempt", 4)) // reopened at the post-commit version
      expect(reopened.hook.result.current.recoveryValue?.reconciliation).toBeDefined()
      gate.open()
      await finishOld() // the old, still-owner instance gets its ok while nobody is looking
      expect(getSubmission({ ...scope(), operation: "log_attempt" })).toMatchObject({ status: "committed-not-seen" })
      const calls = actions.submitMyLeadCommand.mock.calls.length
      const out = await save(reopened.hook) // Reconcile
      expect(out.ok).toBe(false)
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(calls) // no send, no re-key
      expect(reopened.hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "Saved earlier. Refresh to see it." })
      await save(reopened.hook)
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(calls)
      expect(server.db.commits).toBe(1)
      await act(async () => { reopened.hook.result.current.recoveryValue?.refresh() })
      expect(reopened.handlers.onClose).toHaveBeenCalledTimes(1)
      expect(listSubmissions(scope(), () => true)).toEqual([])
      // A genuinely new opening afterwards is a new save with a new key.
      const next = setup(opening("log-attempt", 4))
      expect(next.hook.result.current.recoveryValue).toBeNull()
      await save(next.hook, { ...typed, note: "next intended save" })
      expect(sent(calls).idempotencyKey).not.toBe(sent(0).idempotencyKey)
      expect(server.db.commits).toBe(2)
    })

    it("late ok to an unmounted owner, then reload and reopen: committed-not-seen comes back from storage as Saved earlier; 1 commit", async () => {
      const server = fakeServer(3)
      const gate = gateOf()
      actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => { const r = server.execute(input); await gate.promise; return r })
      const { hook } = setup(opening())
      const finish = startSave(hook)
      hook.unmount()
      gate.open()
      await finish()
      simulateReloadForTests()
      const reopened = setup(opening("log-attempt", 4))
      expect(reopened.hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "Saved earlier. Refresh to see it." })
      const calls = actions.submitMyLeadCommand.mock.calls.length
      await save(reopened.hook)
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(calls)
      await act(async () => { reopened.hook.result.current.recoveryValue?.refresh() })
      expect(reopened.handlers.onClose).toHaveBeenCalledTimes(1)
      expect(server.db.commits).toBe(1)
    })

    it("a commit shown on screen and then closed is SEEN: cleared, and the next opening is a legit new save with a new key (1 per intended save)", async () => {
      const server = fakeServer(3)
      actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => server.execute(input))
      const first = setup(opening())
      await save(first.hook)
      expect(server.db.commits).toBe(1)
      first.hook.rerender({ current: null })
      expect(listSubmissions(scope(), () => true)).toEqual([])
      first.hook.rerender({ current: opening("log-attempt", 4) })
      expect(first.hook.result.current.recoveryValue).toBeNull()
      await save(first.hook, { ...typed, note: "second intended save" })
      expect(sent(1).idempotencyKey).not.toBe(sent(0).idempotencyKey)
      expect(server.db.commits).toBe(2)
    })

    it("a superseded instance that finds the record gone (another host cleared it) gets Refresh-and-close only, never a fresh form; 1 commit", async () => {
      const server = fakeServer(3)
      actions.submitMyLeadCommand
        .mockImplementationOnce(async (_c: string, input: Record<string, unknown>) => { server.execute(input); throw new Error("network") }) // W: committed, response lost
        .mockResolvedValueOnce({ ok: false, answered: true, certainty: "unknown", code: "IDEMPOTENCY_CONFLICT", message: "This was already saved. Refresh to see it." }) // Y
      const w = setup(opening())
      await save(w.hook)
      w.hook.unmount()
      const x = setup(opening())
      const y = setup(opening())
      await save(y.hook) // already-saved
      await act(async () => { y.hook.result.current.recoveryValue?.refresh() }) // another host Refreshes: the record is cleared
      expect(listSubmissions(scope(), () => true)).toEqual([])
      const calls = actions.submitMyLeadCommand.mock.calls.length
      await save(x.hook) // X still holds its old read: refused and re-read
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(calls)
      expect(x.hook.result.current.recoveryValue).toMatchObject({ blocked: true, message: "This lead was updated. Refresh to see it." })
      await save(x.hook)
      expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(calls) // still no way to mint a key
      await act(async () => { x.hook.result.current.recoveryValue?.refresh() })
      expect(x.handlers.onClose).toHaveBeenCalledTimes(1)
      expect(server.db.commits).toBe(1)
    })

    for (const reload of [false, true]) {
      it(`committed-not-seen survives an assignment episode change${reload ? " and a reload" : ""}: Refresh-and-close only, no fresh form, no new key; 1 commit`, async () => {
        const server = fakeServer(3)
        const gate = gateOf()
        actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => { const r = server.execute(input); await gate.promise; return r })
        const { hook } = setup(opening())
        const finish = startSave(hook)
        hook.unmount()
        gate.open()
        await finish() // late ok to an unmounted owner: committed-not-seen in ep-1
        if (reload) simulateReloadForTests()
        const calls = actions.submitMyLeadCommand.mock.calls.length
        const reopened = setup({ action: "log-attempt", row: { ...row(1), assignmentEpisodeId: "ep-2" } as QueueRow })
        expect(reopened.hook.result.current.recoveryValue).toMatchObject({ blocked: true })
        expect(reopened.hook.result.current.recoveryValue?.saveAsNew).toBeUndefined()
        await save(reopened.hook)
        expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(calls) // never a fresh key
        await act(async () => { reopened.hook.result.current.recoveryValue?.refresh() })
        expect(reopened.handlers.onClose).toHaveBeenCalledTimes(1)
        expect(listSubmissions(scope(), () => true)).toEqual([]) // the original marker is cleared
        expect(server.db.commits).toBe(1)
      })
    }

    it("a genuinely new opening on an empty store mints a key and commits once", async () => {
      const server = fakeServer(3)
      actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => server.execute(input))
      const { hook } = setup(opening())
      expect(hook.result.current.recoveryValue).toBeNull()
      await save(hook)
      expect(server.db.commits).toBe(1)
    })

    it("a reload with an unresolved record only in sessionStorage still triggers the sign-out confirm; declining keeps the key, accepting clears and bumps the epoch; 1 commit", async () => {
      const server = fakeServer(3)
      actions.submitMyLeadCommand.mockImplementationOnce(async (_c: string, input: Record<string, unknown>) => { server.execute(input); throw new Error("network") })
        .mockImplementation(async (_c: string, input: Record<string, unknown>) => server.execute(input))
      const first = setup(opening())
      await save(first.hook)
      first.hook.unmount()
      simulateReloadForTests() // memory gone; the record survives only in sessionStorage
      expect(window.sessionStorage.getItem(SUBMISSION_STORAGE_KEY)).not.toBeNull()
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
      render(<SignOutForm />)
      const form = screen.getByRole("button", { name: "Sign out" }).closest("form")!
      const proceeded = fireEvent.submit(form)
      expect(confirm).toHaveBeenCalledWith("A save may still be going through. Sign out anyway?")
      expect(proceeded).toBe(false)
      const key = getSubmission({ ...scope(), operation: "log_attempt" })!.key
      expect(key).toBe(sent(0).idempotencyKey)
      const again = setup(opening())
      await save(again.hook)
      expect(sent(1).idempotencyKey).toBe(key) // declining kept the key: the re-save is a duplicate
      expect(server.db.commits).toBe(1)
      confirm.mockReturnValue(true)
      form.addEventListener("submit", (event) => event.preventDefault())
      const epoch = getEpoch()
      fireEvent.submit(form)
      expect(getEpoch()).toBeGreaterThan(epoch)
      expect(window.sessionStorage.getItem(SUBMISSION_STORAGE_KEY)).toBeNull()
    })

    it("committed-not-seen older than 24 hours is dropped: a fresh form on reopen (accepted risk) and a deliberate new save", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      try {
        const server = fakeServer(3)
        const gate = gateOf()
        actions.submitMyLeadCommand.mockImplementation(async (_c: string, input: Record<string, unknown>) => { const r = server.execute(input); await gate.promise; return r })
        const { hook } = setup(opening())
        const finish = startSave(hook)
        hook.unmount()
        gate.open()
        await finish()
        expect(getSubmission({ ...scope(), operation: "log_attempt" })).toMatchObject({ status: "committed-not-seen" })
        vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
        const reopened = setup(opening("log-attempt", 4))
        expect(reopened.hook.result.current.recoveryValue).toBeNull()
        await save(reopened.hook, { ...typed, note: "deliberate new save" })
        expect(server.db.commits).toBe(2)
      } finally { vi.useRealTimers() }
    })
  })

  it("a record is never taken over under a DIFFERENT key: an unresolved record created elsewhere wins and this instance stands down", async () => {
    const server = fakeServer(3)
    actions.submitMyLeadCommand.mockImplementationOnce(async (_c: string, input: Record<string, unknown>) => { server.execute(input); throw new Error("network") })
      .mockImplementation(async (_c: string, input: Record<string, unknown>) => server.execute(input))
    const early = setup(opening()) // opened with no record yet
    const other = setup(opening())
    await save(other.hook) // another host sends: record created, response lost
    const out = await save(early.hook, typed) // this instance would mint a different key for the same save
    expect(out.ok).toBe(false)
    expect(actions.submitMyLeadCommand).toHaveBeenCalledTimes(1)
    expect(server.db.commits).toBe(1)
  })
})
