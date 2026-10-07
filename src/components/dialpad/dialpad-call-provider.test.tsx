import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  dialLead: vi.fn(),
  status: vi.fn(),
  loadMyLeadQueueRow: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/app/(dashboard)/my-leads/dialpad-actions", () => ({
  dialLeadAction: (...a: unknown[]) => mocks.dialLead(...a),
  getDialpadCallStatusAction: (...a: unknown[]) => mocks.status(...a),
  cancelDialpadCallAction: vi.fn(),
  ensureDialpadBindingAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({ loadMyLeadQueueRow: (...a: unknown[]) => mocks.loadMyLeadQueueRow(...a), savePostCallExtras: vi.fn() }));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn() }));
vi.mock("@/app/(dashboard)/my-leads/_components/use-attempt-workflow", () => ({
  useAttemptWorkflow: () => ({ submit: mocks.submit, recoveryValue: null, onDripChanged: vi.fn(), confirmClose: vi.fn() }),
}));

import { CallLockProvider } from "@/components/calls/call-lock-context";
import { useOptionalDialpadCall, type DialpadEndedCall, type DialpadPageHandlers } from "./dialpad-call-context";
import { DialpadCallProvider } from "./dialpad-call-provider";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const ended = { ok: true, status: { state: "ended", connected: true, durationSeconds: 60, callActivityId: "call-1" } };

function Starter() {
  const dialpad = useOptionalDialpadCall();
  return <button onClick={() => dialpad?.startCall({ propertyId: PROPERTY, contactId: "c-1", label: "Pat Seller" })}>start</button>;
}
function Registrar({ name, handlers }: { name: string; handlers: DialpadPageHandlers }) {
  const register = useOptionalDialpadCall()?.registerPageHandlers;
  useEffect(() => register?.(handlers), [register, handlers]);
  return <span>{name}</span>;
}
function LoggedProbe() {
  const dialpad = useOptionalDialpadCall();
  return (
    <>
      <output data-testid="logged">{[...(dialpad?.loggedCallActivityIds ?? [])].join(",")}</output>
      <button onClick={() => dialpad?.clearEndedCall?.("call-1")}>mark logged</button>
    </>
  );
}

const viewer = { userId: "rep-1", orgId: "org-1", label: "Maria" };
const row = {
  propertyId: PROPERTY, stage: "contacted", queueVersion: 1, sharedStatus: "active", assignmentEpisodeId: "ep-1", address: "123 Main St", nextStepAt: null,
};

describe("DialpadCallProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dialLead.mockResolvedValue({ ok: true, intentId: "i-1", state: "dialing", uncertain: false });
    mocks.status.mockResolvedValue(ended);
    mocks.submit.mockResolvedValue({ ok: true, attemptRecorded: true });
  });

  it("a stale page's unregister never clears the newer page's handlers", async () => {
    const user = userEvent.setup();
    const a = { onEnded: vi.fn() };
    const b = { onEnded: vi.fn() };
    function Pages() {
      const [showA, setShowA] = useState(true);
      return (
        <>
          {showA ? <Registrar name="page-a" handlers={a} /> : null}
          <Registrar name="page-b" handlers={b} />
          <button onClick={() => setShowA(false)}>leave a</button>
        </>
      );
    }
    render(
      <CallLockProvider>
        <DialpadCallProvider enabled>
          <Starter />
          <Pages />
        </DialpadCallProvider>
      </CallLockProvider>,
    );
    // Page A (older) unmounts AFTER page B registered: B must stay active.
    await user.click(screen.getByText("leave a"));
    await user.click(screen.getByText("start"));
    await waitFor(() => expect(b.onEnded).toHaveBeenCalledTimes(1));
    expect(a.onEnded).not.toHaveBeenCalled();
    const info = b.onEnded.mock.calls[0]![0] as DialpadEndedCall;
    expect(info).toMatchObject({ propertyId: PROPERTY, callActivityId: "call-1", talkSeconds: 60 });
  });

  it("clearEndedCall records the call as logged so a stale poll cannot reopen it", async () => {
    const user = userEvent.setup();
    render(
      <CallLockProvider>
        <DialpadCallProvider enabled>
          <LoggedProbe />
        </DialpadCallProvider>
      </CallLockProvider>,
    );
    expect(screen.getByTestId("logged")).toHaveTextContent("");
    await user.click(screen.getByText("mark logged"));
    expect(screen.getByTestId("logged")).toHaveTextContent("call-1");
  });

  it("Log outcome from a page with no handler (Messages, a lead page) opens the bound prompt in place and clears the panel on save", async () => {
    const user = userEvent.setup();
    mocks.loadMyLeadQueueRow.mockResolvedValue({ ok: true, lookup: { status: "found", row } });
    render(
      <CallLockProvider>
        <DialpadCallProvider enabled loggingViewer={viewer}>
          <Starter />
        </DialpadCallProvider>
      </CallLockProvider>,
    );
    await user.click(screen.getByText("start"));
    const logButton = await screen.findByRole("button", { name: "Log outcome" });
    await user.click(logButton);
    const prompt = await screen.findByTestId("post-call-prompt");
    expect(mocks.loadMyLeadQueueRow).toHaveBeenCalledWith({ memberId: "rep-1", propertyId: PROPERTY });
    // Bound to the call: no manual DialPad or recording-link fields.
    expect(screen.queryByText("Where was this call?")).toBeNull();
    expect(screen.queryByText(/Recording link/)).toBeNull();
    await user.click(within(screen.getByTestId("post-call-outcome")).getByRole("radio", { name: "Reached" }));
    await user.click(within(prompt).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ source: "sandra", callActivityId: "call-1", propertyId: PROPERTY });
  });

  it("offers no Log outcome without a logging viewer or a page handler", async () => {
    const user = userEvent.setup();
    render(
      <CallLockProvider>
        <DialpadCallProvider enabled>
          <Starter />
        </DialpadCallProvider>
      </CallLockProvider>,
    );
    await user.click(screen.getByText("start"));
    await screen.findByText(/Call ended/);
    expect(screen.queryByRole("button", { name: "Log outcome" })).toBeNull();
    await act(async () => undefined);
  });

  it("says so when the lead is not in the rep's queue", async () => {
    const user = userEvent.setup();
    mocks.loadMyLeadQueueRow.mockResolvedValue({ ok: true, lookup: { status: "unavailable", reason: "not_in_queue" } });
    render(
      <CallLockProvider>
        <DialpadCallProvider enabled loggingViewer={viewer}>
          <Starter />
        </DialpadCallProvider>
      </CallLockProvider>,
    );
    await user.click(screen.getByText("start"));
    await user.click(await screen.findByRole("button", { name: "Log outcome" }));
    expect(await screen.findByTestId("log-outcome-error")).toHaveTextContent(/not in your My Leads queue/);
  });
});
