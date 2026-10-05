import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallFactChips } from "./call-fact-chips";
import type { LeadCallFactsView } from "./types";

afterEach(cleanup);

const facts: LeadCallFactsView = {
  factId: "f1",
  chips: [
    { field: "asking_price", value: "$185,000", evidence: "I want about 185k" },
    { field: "next_step", value: "Tuesday at 2", evidence: "call me Tuesday at 2" },
    { field: "condition", value: "needs a roof", evidence: "the roof is shot" },
  ],
};

const make = (over: Partial<Parameters<typeof CallFactChips>[0]> = {}) => {
  const onAccept = vi.fn(async () => ({ ok: true as const, value: "$185,000" }));
  const onDismiss = vi.fn(async () => ({ ok: true as const }));
  const onAccepted = vi.fn();
  const utils = render(<CallFactChips facts={facts} onAccept={onAccept} onDismiss={onDismiss} onAccepted={onAccepted} {...over} />);
  return { onAccept, onDismiss, onAccepted, ...utils };
};

describe("CallFactChips", () => {
  it("renders one chip per field in the given order with its evidence, condition last, saving nothing", () => {
    const { onAccept } = make();
    const order = screen.getAllByRole("listitem").map((li) => li.getAttribute("data-testid"));
    expect(order).toEqual(["call-fact-chip-asking_price", "call-fact-chip-next_step", "call-fact-chip-condition"]);
    expect(screen.getByTestId("call-fact-evidence-asking_price").getAttribute("title")).toBe("I want about 185k");
    expect(screen.getByText("Tuesday at 2")).toBeTruthy(); // the verbatim phrase, never a derived date
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("Accept calls onAccept for that field only, then removes the chip and reports the value", async () => {
    const { onAccept, onAccepted } = make();
    fireEvent.click(screen.getByTestId("call-fact-accept-asking_price"));
    await waitFor(() => expect(screen.queryByTestId("call-fact-chip-asking_price")).toBeNull());
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith("asking_price");
    expect(onAccepted).toHaveBeenCalledWith("asking_price", "$185,000");
    expect(screen.getByTestId("call-fact-chip-condition")).toBeTruthy();
  });

  it("a failed accept keeps the chip and shows the message", async () => {
    make({ onAccept: vi.fn(async () => ({ ok: false as const, message: "Next step not set: nope" })) });
    fireEvent.click(screen.getByTestId("call-fact-accept-next_step"));
    expect((await screen.findByRole("alert")).textContent).toBe("Next step not set: nope");
    expect(screen.getByTestId("call-fact-chip-next_step")).toBeTruthy();
  });

  it("a thrown accept shows a retry message instead of crashing", async () => {
    make({ onAccept: vi.fn(async () => { throw new Error("x"); }) });
    fireEvent.click(screen.getByTestId("call-fact-accept-condition"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/retry/i);
  });

  it("Dismiss hides the whole panel and calls onDismiss once", async () => {
    const onDismissed = vi.fn();
    const { onDismiss } = make({ onDismissed });
    fireEvent.click(screen.getByTestId("call-fact-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("call-fact-chips")).toBeNull());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismissed).toHaveBeenCalled();
  });

  it("renders nothing once every chip is accepted", async () => {
    make({ facts: { factId: "f1", chips: [facts.chips[0]] } });
    fireEvent.click(screen.getByTestId("call-fact-accept-asking_price"));
    await waitFor(() => expect(screen.queryByTestId("call-fact-chips")).toBeNull());
  });
});
