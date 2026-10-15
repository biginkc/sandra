import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), send: vi.fn(), acknowledge: vi.fn() }));
vi.mock("../sms-actions", () => ({ loadRepSmsContext: mocks.load, sendRepSms: mocks.send, acknowledgeRepSmsSubmission: mocks.acknowledge }));

import { AllTexts } from "./all-texts";

const group = { rows: [], hasMore: false, nextCursor: null };
const thread = (...inbound: Array<[string, string]>) => ({
  status: "ready" as const,
  detail: {
    messages: { rows: inbound.map(([id, createdAt]) => ({ id, body: "hi", direction: "inbound" as const, createdAt, createdLabel: "", deliveryStatus: "received", attachmentCount: 0 })), hasMore: false, nextCursor: null },
    notes: group, attempts: group, appointments: group, offers: group, history: group,
  },
});
const latest = (messageId: string, at: string) => ({ propertyId: "lead-1", latestInbound: { at, kind: "text" as const, messageId, handled: false, contactOnly: false } });

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  mocks.load.mockResolvedValue({
    ok: true,
    data: {
      orgId: "o", actorId: "a", contactId: "c", phone: "+18165550123", provider: "sendillo", obligation: null,
      senders: [{ id: "s1", number: "+18163706846", label: "Mel", isDefault: true, provider: "sendillo", providerSenderId: "p", grantStatus: "active", compositionPolicyVersion: 1 }],
    },
  });
  mocks.send.mockResolvedValue({ ok: true, data: { outcome: { status: "sent", messageId: "m-out", externalId: "e" } } });
  mocks.acknowledge.mockResolvedValue({ ok: true, data: { ok: true, state: "accepted" } });
});

async function compose(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Acquisitions manager"), "Maria");
  await user.type(screen.getByLabelText("Editable message remainder"), "Call you tomorrow");
  await user.click(screen.getByRole("button", { name: "Send text" }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalled());
}

describe("<AllTexts /> reply-to stamp with the real composer", () => {
  it("a thread that failed to load never mounts the composer, so nothing can send unstamped", async () => {
    const onRetry = vi.fn();
    const view = render(<AllTexts facts={latest("Y", "2026-10-14T15:00:00Z")} state={{ status: "error", message: "Connection unavailable" }} onRetry={onRetry} defaultOpen />);
    expect(screen.queryByTestId("rep-sms-composer")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Editable message remainder")).not.toBeInTheDocument();
    // Once the thread loads and displays Y, the composer opens and stamps it.
    view.rerender(<AllTexts facts={latest("Y", "2026-10-14T15:00:00Z")} state={thread(["Y", "2026-10-14T15:00:00Z"])} onRetry={onRetry} defaultOpen />);
    await screen.findByLabelText("Editable message remainder");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a reply Y that arrives after X was displayed blocks Reply until the thread shows Y, then stamps Y", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const view = render(<AllTexts facts={latest("X", "2026-10-14T14:00:00Z")} state={thread(["X", "2026-10-14T14:00:00Z"])} onRetry={onRetry} defaultOpen />);
    await screen.findByLabelText("Editable message remainder");
    view.unmount();

    // Facts now say Y is the newest inbound; the loaded thread still ends at X.
    const stale = render(<AllTexts facts={latest("Y", "2026-10-14T15:00:00Z")} state={thread(["X", "2026-10-14T14:00:00Z"])} onRetry={onRetry} defaultOpen />);
    expect(screen.getByTestId("all-texts-stale-lead-1")).toHaveTextContent("New reply arrived");
    expect(screen.queryByTestId("rep-sms-composer")).not.toBeInTheDocument();
    expect(onRetry).toHaveBeenCalledTimes(1);

    // The thread refreshes and now displays Y.
    stale.rerender(<AllTexts facts={latest("Y", "2026-10-14T15:00:00Z")} state={thread(["Y", "2026-10-14T15:00:00Z"], ["X", "2026-10-14T14:00:00Z"])} onRetry={onRetry} defaultOpen />);
    expect(screen.queryByTestId("all-texts-stale-lead-1")).not.toBeInTheDocument();
    await compose(user);
    expect(mocks.send.mock.calls[0][0].inboundMessageId).toBe("Y");
  });

  it("a composer already open on X keeps X as its stamp when Y arrives; Y is never stamped unseen", async () => {
    const user = userEvent.setup();
    const view = render(<AllTexts facts={latest("X", "2026-10-14T14:00:00Z")} state={thread(["X", "2026-10-14T14:00:00Z"])} onRetry={() => {}} defaultOpen />);
    await screen.findByLabelText("Editable message remainder");
    view.rerender(<AllTexts facts={latest("Y", "2026-10-14T15:00:00Z")} state={thread(["X", "2026-10-14T14:00:00Z"])} onRetry={() => {}} defaultOpen />);
    expect(screen.getByTestId("all-texts-stale-lead-1")).toBeInTheDocument();
    expect(screen.getByLabelText("Editable message remainder")).toBeInTheDocument();
    await compose(user);
    expect(mocks.send.mock.calls[0][0].inboundMessageId).toBe("X");
  });

  it("a failed send retried under the same key keeps the stamp it was created with", async () => {
    const user = userEvent.setup();
    mocks.send.mockResolvedValueOnce({ ok: true, data: { outcome: { status: "provider_unknown", messageId: "m1", error: "unclear" } } });
    const view = render(<AllTexts facts={latest("X", "2026-10-14T14:00:00Z")} state={thread(["X", "2026-10-14T14:00:00Z"])} onRetry={() => {}} defaultOpen />);
    await screen.findByLabelText("Editable message remainder");
    await compose(user);
    view.rerender(<AllTexts facts={latest("Y", "2026-10-14T15:00:00Z")} state={thread(["Y", "2026-10-14T15:00:00Z"], ["X", "2026-10-14T14:00:00Z"])} onRetry={() => {}} defaultOpen />);
    await user.click(await screen.findByRole("button", { name: "Reconcile saved send" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1][0].inboundMessageId).toBe("X");
    expect(mocks.send.mock.calls[1][0].idempotencyKey).toBe(mocks.send.mock.calls[0][0].idempotencyKey);
  });
});
