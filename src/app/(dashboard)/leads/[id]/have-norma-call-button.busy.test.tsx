import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// RED: plan rule 3 — the button maps `capacity_*` / `number_busy` to a new `busy_try_again` result (S2: one capacity gate
// shared by button and queue). Pattern copied from have-norma-call-button.test.tsx. Copy is not asserted (needs Jarrad).
const mocks = vi.hoisted(() => ({
  previewNormaCall: vi.fn(),
  requestNormaCall: vi.fn(),
  refresh: vi.fn(),
  markNormaCallReviewed: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./norma-actions", () => ({
  previewNormaCall: mocks.previewNormaCall,
  requestNormaCall: mocks.requestNormaCall,
  markNormaCallReviewed: mocks.markNormaCallReviewed,
}));

import { HaveNormaCallButton } from "./have-norma-call-button";

async function confirmCall() {
  render(<HaveNormaCallButton propertyId="p1" sellerName="Pat Seller" propertyAddress="12 Oak St" openRequest={null} />);
  fireEvent.click(screen.getByTestId("have-norma-call-trigger"));
  await screen.findByTestId("norma-call-number");
  fireEvent.click(screen.getByTestId("norma-call-confirm"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.previewNormaCall.mockResolvedValue({ callable: true, phoneE164: "+18165550142" });
  mocks.requestNormaCall.mockResolvedValue({ ok: false, code: "busy_try_again" });
});

describe("HaveNormaCallButton — busy_try_again", () => {
  it("shows a notice (not the generic 'could not place' text) and does not claim a call is in progress", async () => {
    await confirmCall();
    const notice = await screen.findByTestId("norma-call-notice");
    expect(notice).toHaveAttribute("data-code", "busy_try_again");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("is a retryable refusal: the lead is re-checked and Confirm is usable again", async () => {
    await confirmCall();
    await screen.findByTestId("norma-call-notice");
    await waitFor(() => expect(mocks.previewNormaCall).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("norma-call-confirm")).toBeEnabled());
  });

  it("differs from the in-flight result, which holds the lead and disables Confirm", async () => {
    mocks.requestNormaCall.mockResolvedValue({ ok: false, code: "in_flight", requestId: "r1" });
    await confirmCall();
    await screen.findByTestId("norma-call-notice");
    expect(screen.getByTestId("norma-call-confirm")).toBeDisabled();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows the approved busy wording (Jarrad 2026-10-07)", async () => {
    await confirmCall();
    expect(await screen.findByTestId("norma-call-notice")).toHaveTextContent("Norma is busy. Try again shortly. No call was placed.");
  });
});
