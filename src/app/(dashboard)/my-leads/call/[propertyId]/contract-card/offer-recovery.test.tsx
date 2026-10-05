import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OfferConflictRows, OfferRecovery, type OfferRecoveryTarget } from "./offer-recovery";

afterEach(cleanup);

const target = (over: Partial<OfferRecoveryTarget> = {}): OfferRecoveryTarget => ({
  projectionId: "p1", propertyId: "prop", conflictCode: "PENDING_OFFER_EXISTS", requestId: "r1", amountCents: 21000000, pendingOfferAmountCents: 15000000, ...over,
});
const actions = () => ({
  retry: vi.fn(async () => ({ ok: true as const, state: "logged" })),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  supersede: vi.fn(async (_id: string, _key: string) => ({ ok: true as const, state: "logged" })),
  reassign: vi.fn(async () => ({ ok: true as const, state: "logged" })),
  cancel: vi.fn(async () => ({ ok: true as const, state: "cancelled" })),
});

describe("OfferRecovery", () => {
  it("always states the policy and the reconcile banner", () => {
    render(<OfferRecovery target={target()} actions={actions()} />);
    expect(screen.getByRole("alert").textContent).toBe("Contract sent, offer needs reconciling");
    expect(screen.getByTestId("recovery-policy").textContent).toBe("The contract was sent. Sandra never sends it again.");
  });

  it("PENDING_OFFER_EXISTS: supersede asks for confirmation listing both amounts, and replays one key", async () => {
    const a = actions();
    a.supersede.mockResolvedValueOnce({ ok: false, code: "X", message: "nope" } as never);
    render(<OfferRecovery target={target()} actions={a} />);
    expect(screen.getByTestId("recovery-cancel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("recovery-supersede"));
    const confirm = screen.getByTestId("recovery-confirm").textContent!;
    expect(confirm).toContain("$150,000.00");
    expect(confirm).toContain("$210,000.00");
    expect(a.supersede).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("recovery-confirm-supersede"));
    await waitFor(() => expect(screen.getByTestId("recovery-message").textContent).toBe("nope"));
    fireEvent.click(screen.getByTestId("recovery-confirm-supersede"));
    await waitFor(() => expect(a.supersede).toHaveBeenCalledTimes(2));
    // A failure with rotateKey rotates the key; the second call is a fresh, valid key.
    expect(a.supersede.mock.calls[0][0]).toBe("p1");
    expect(a.supersede.mock.calls[1][1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("STALE_ASSIGNMENT: reassign and cancel", async () => {
    const a = actions();
    const done = vi.fn();
    render(<OfferRecovery target={target({ conflictCode: "STALE_ASSIGNMENT" })} actions={a} onDone={done} />);
    expect(screen.queryByTestId("recovery-supersede")).toBeNull();
    fireEvent.click(screen.getByTestId("recovery-reassign"));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(a.reassign).toHaveBeenCalledWith("p1");
    fireEvent.click(screen.getByTestId("recovery-cancel"));
    await waitFor(() => expect(a.cancel).toHaveBeenCalledWith("r1"));
  });

  it("STALE_STATE, DNC_LOCKED and AMOUNT_MISMATCH: only cancel and Open lead, no automatic log", () => {
    for (const code of ["STALE_STATE", "DNC_LOCKED", "AMOUNT_MISMATCH"]) {
      const { unmount } = render(<OfferRecovery target={target({ conflictCode: code })} actions={actions()} />);
      expect(screen.getByTestId("recovery-cancel")).toBeTruthy();
      expect(screen.getByTestId("recovery-open-lead").getAttribute("href")).toBe("/leads/prop");
      expect(screen.queryByTestId("recovery-retry")).toBeNull();
      expect(screen.queryByTestId("recovery-supersede")).toBeNull();
      expect(screen.queryByTestId("recovery-reassign")).toBeNull();
      unmount();
    }
  });

  it("transient or exhausted: retry logging only", async () => {
    const a = actions();
    render(<OfferRecovery target={target({ conflictCode: "PROJECTION_RETRY_EXHAUSTED" })} actions={a} />);
    fireEvent.click(screen.getByTestId("recovery-retry"));
    await waitFor(() => expect(a.retry).toHaveBeenCalledWith("p1"));
  });

  it("an action that throws shows plain copy and never changes anything", async () => {
    const a = actions();
    a.retry.mockRejectedValueOnce(new Error("boom"));
    render(<OfferRecovery target={target({ conflictCode: "X" })} actions={a} />);
    fireEvent.click(screen.getByTestId("recovery-retry"));
    await waitFor(() => expect(screen.getByTestId("recovery-message").textContent).toContain("Nothing was changed"));
  });
});

describe("OfferConflictRows", () => {
  it("renders nothing without rows and one recovery per row", () => {
    const { container, rerender } = render(<OfferConflictRows rows={[]} actions={actions()} />);
    expect(container.innerHTML).toBe("");
    rerender(<OfferConflictRows rows={[{ ...target(), address: "1 Main St" }]} actions={actions()} />);
    expect(screen.getByText("1 Main St")).toBeTruthy();
    expect(screen.getAllByTestId("offer-recovery")).toHaveLength(1);
  });
});
