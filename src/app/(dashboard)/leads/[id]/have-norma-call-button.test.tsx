import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  previewNormaCall: vi.fn(),
  requestNormaCall: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./norma-actions", () => ({
  previewNormaCall: mocks.previewNormaCall,
  requestNormaCall: mocks.requestNormaCall,
}));

import { HaveNormaCallButton } from "./have-norma-call-button";

const PHONE = "+18165550142";

function renderButton(openRequest: { id: string; status: string } | null = null) {
  return render(
    <HaveNormaCallButton propertyId="p1" sellerName="Pat Seller" propertyAddress="12 Oak St" openRequest={openRequest} />,
  );
}

async function openPanel() {
  fireEvent.click(screen.getByTestId("have-norma-call-trigger"));
  return screen.findByTestId("have-norma-call-panel");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.previewNormaCall.mockResolvedValue({ callable: true, phoneE164: PHONE });
  mocks.requestNormaCall.mockResolvedValue({ ok: true, code: "calling", requestId: "r1" });
});

afterEach(() => vi.useRealTimers());

describe("HaveNormaCallButton", () => {
  it("shows seller, property and the number that would be dialled, with Confirm enabled", async () => {
    renderButton();
    const panel = await openPanel();
    expect(panel.textContent).toContain("Pat Seller");
    expect(panel.textContent).toContain("12 Oak St");
    expect(await screen.findByTestId("norma-call-number")).toHaveTextContent("(816) 555-0142");
    expect(screen.getByTestId("norma-call-confirm")).toBeEnabled();
    expect(mocks.requestNormaCall).not.toHaveBeenCalled();
  });

  it("shows a plain reason and disables Confirm for each kind of block", async () => {
    const cases: [unknown, RegExp][] = [
      [{ callable: false, block: { code: "blocked", reason: "dnc_locked" } }, /do-not-contact/],
      [{ callable: false, block: { code: "blocked", reason: "not_interested" } }, /not interested/],
      [{ callable: false, block: { code: "no_callable_number" } }, /no number Norma can call/],
      [{ callable: false, block: { code: "gate_off", reason: "dispatch_disabled" } }, /switched off/],
      [{ callable: false, block: { code: "in_flight" } }, /already in progress/],
    ];
    for (const [preview, pattern] of cases) {
      mocks.previewNormaCall.mockResolvedValue(preview);
      const { unmount } = renderButton();
      await openPanel();
      expect(await screen.findByTestId("norma-call-blocked")).toHaveTextContent(pattern);
      expect(screen.getByTestId("norma-call-confirm")).toBeDisabled();
      unmount();
    }
  });

  it("keeps Confirm disabled while the check is loading and when it fails", async () => {
    let resolve!: (value: unknown) => void;
    mocks.previewNormaCall.mockReturnValue(new Promise((r) => (resolve = r)));
    renderButton();
    await openPanel();
    expect(screen.getByTestId("norma-call-loading")).toBeInTheDocument();
    expect(screen.getByTestId("norma-call-confirm")).toBeDisabled();
    await act(async () => resolve({ callable: false, block: { code: "error" } }));
    expect(await screen.findByTestId("norma-call-blocked")).toHaveTextContent(/Nothing was sent/);
  });

  it("sends the trimmed optional context on Confirm, refreshes, and cannot be confirmed twice", async () => {
    renderButton();
    await openPanel();
    await screen.findByTestId("norma-call-number");
    fireEvent.change(screen.getByLabelText(/Context for Norma/), { target: { value: "  seller texted yes  " } });
    fireEvent.click(screen.getByTestId("norma-call-confirm"));
    await waitFor(() => expect(mocks.requestNormaCall).toHaveBeenCalledWith("p1", "seller texted yes"));
    expect(await screen.findByTestId("norma-call-notice")).toHaveTextContent(/Norma is calling now/);
    expect(mocks.refresh).toHaveBeenCalled();
    expect(screen.getByTestId("norma-call-confirm")).toBeDisabled();
    fireEvent.click(screen.getByTestId("norma-call-confirm"));
    expect(mocks.requestNormaCall).toHaveBeenCalledTimes(1);
  });

  it("sends null context when the box is empty", async () => {
    renderButton();
    await openPanel();
    await screen.findByTestId("norma-call-number");
    fireEvent.click(screen.getByTestId("norma-call-confirm"));
    await waitFor(() => expect(mocks.requestNormaCall).toHaveBeenCalledWith("p1", null));
  });

  it("warns, and does not offer a retry, when the send could not be confirmed", async () => {
    mocks.requestNormaCall.mockResolvedValue({ ok: true, code: "dispatch_unknown", requestId: "r1" });
    renderButton();
    await openPanel();
    await screen.findByTestId("norma-call-number");
    fireEvent.click(screen.getByTestId("norma-call-confirm"));
    expect(await screen.findByTestId("norma-call-notice")).toHaveTextContent(/could not confirm/);
    expect(screen.getByTestId("norma-call-confirm")).toBeDisabled();
  });

  it("shows a refusal from the action as an error and re-checks the lead", async () => {
    mocks.requestNormaCall.mockResolvedValue({ ok: false, code: "blocked", reason: "global_dnc_registry" });
    renderButton();
    await openPanel();
    await screen.findByTestId("norma-call-number");
    fireEvent.click(screen.getByTestId("norma-call-confirm"));
    expect(await screen.findByTestId("norma-call-notice")).toHaveTextContent(/do-not-contact list/);
    await waitFor(() => expect(mocks.previewNormaCall).toHaveBeenCalledTimes(2));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("shows the in-flight state, with no Confirm and no preview, while a request is open", async () => {
    renderButton({ id: "r1", status: "dispatched" });
    expect(screen.getByTestId("have-norma-call-trigger")).toHaveTextContent("Norma call in progress");
    await openPanel();
    expect(screen.getByTestId("norma-call-state")).toHaveTextContent(/summary will appear/);
    expect(screen.queryByTestId("norma-call-confirm")).toBeNull();
    expect(mocks.previewNormaCall).not.toHaveBeenCalled();
  });

  it("shows unconfirmed and needs-review states", async () => {
    const { unmount } = renderButton({ id: "r1", status: "dispatch_unknown" });
    expect(screen.getByTestId("have-norma-call-trigger")).toHaveTextContent("Norma call unconfirmed");
    unmount();
    renderButton({ id: "r1", status: "needs_review" });
    expect(screen.getByTestId("have-norma-call-trigger")).toHaveTextContent("Norma call needs review");
    await openPanel();
    expect(screen.getByTestId("norma-call-state")).toHaveTextContent(/person needs to review/);
  });

  it("re-reads the lead periodically only while a request is open", () => {
    vi.useFakeTimers();
    const { unmount } = renderButton();
    vi.advanceTimersByTime(120_000);
    expect(mocks.refresh).not.toHaveBeenCalled();
    unmount();
    renderButton({ id: "r1", status: "dispatched" });
    vi.advanceTimersByTime(31_000);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not poll a request that is waiting for a person", () => {
    vi.useFakeTimers();
    renderButton({ id: "r1", status: "needs_review" });
    vi.advanceTimersByTime(120_000);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("labels the trigger Have Norma call when idle", () => {
    renderButton();
    expect(screen.getByTestId("have-norma-call-trigger")).toHaveTextContent("Have Norma call");
  });

  describe("status colours and the second call", () => {
    const withLast = (outcome: string | null) =>
      render(
        <HaveNormaCallButton propertyId="p1" sellerName="Pat" propertyAddress="12 Oak St" lastResult={{ id: "r0", outcome }} />,
      );

    it("shows the last finished call in green when it reached a person", () => {
      for (const outcome of ["reached_no_callback", "callback_requested", "not_interested", "wrong_number"]) {
        const { unmount } = withLast(outcome);
        expect(screen.getByTestId("norma-last-result")).toHaveAttribute("data-tone", "green");
        unmount();
      }
    });

    it("grey for no answer, amber for an unknown result, nothing when there is no finished call", () => {
      const a = withLast("no_answer");
      expect(screen.getByTestId("norma-last-result")).toHaveAttribute("data-tone", "neutral");
      expect(screen.getByTestId("norma-last-result")).toHaveTextContent("Norma: No answer");
      a.unmount();
      const b = withLast("unknown");
      expect(screen.getByTestId("norma-last-result")).toHaveAttribute("data-tone", "amber");
      b.unmount();
      render(<HaveNormaCallButton propertyId="p1" sellerName="Pat" propertyAddress="12 Oak St" />);
      expect(screen.queryByTestId("norma-last-result")).toBeNull();
    });

    it("hides the last result while a new call is in flight; in-flight is neutral, needs review is amber", () => {
      const a = render(
        <HaveNormaCallButton propertyId="p1" sellerName="Pat" propertyAddress="12 Oak St" openRequest={{ id: "r1", status: "dispatched" }} lastResult={{ id: "r0", outcome: "callback_requested" }} />,
      );
      expect(screen.queryByTestId("norma-last-result")).toBeNull();
      expect(screen.getByTestId("have-norma-call-trigger")).toHaveAttribute("data-tone", "neutral");
      a.unmount();
      render(<HaveNormaCallButton propertyId="p1" sellerName="Pat" propertyAddress="12 Oak St" openRequest={{ id: "r1", status: "needs_review" }} />);
      expect(screen.getByTestId("have-norma-call-trigger")).toHaveAttribute("data-tone", "amber");
    });

    it("says Norma is calling again on the second attempt", () => {
      render(
        <HaveNormaCallButton propertyId="p1" sellerName="Pat" propertyAddress="12 Oak St" openRequest={{ id: "r1", status: "requested", attempt: 2 }} />,
      );
      expect(screen.getByTestId("have-norma-call-trigger")).toHaveTextContent("Norma calling again");
    });
  });
});
