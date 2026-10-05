import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContractCard } from "./contract-card";
import { BUYER, novationBase, TITLE } from "./fixtures";
import type { ContractCardState } from "../types";

afterEach(cleanup);

const freshComp = () => ({ ...novationBase().comp!, fetchedAt: new Date(Date.now() - 86400000).toISOString() });
const state = (over: Record<string, unknown> = {}): ContractCardState => ({
  enabled: true, testMode: true, templateId: "t", sellerRoleName: "Seller",
  signerRoles: [{ name: "Seller", order: 0 }, { name: "Buyer", order: 1 }],
  sellerSigner: { name: "Sam Seller", emailAddress: "sam@example.test" },
  prefillBase: { ...novationBase(), comp: freshComp() },
  titleCompanies: [TITLE], buyerEntities: [BUYER],
  selectedTitleCompanyId: TITLE.id, selectedBuyerEntityId: BUYER.id,
  todayCentral: "2026-10-04", tomorrowCentral: "2026-10-05", ...over,
}) as ContractCardState;

const fill = () => {
  fireEvent.change(screen.getByTestId("contract-price"), { target: { value: "210000" } });
  fireEvent.change(screen.getByTestId("contract-closing-date"), { target: { value: "2099-01-02" } });
};
const sendBtn = () => screen.getByTestId("contract-send") as HTMLButtonElement;

describe("ContractCard", () => {
  it("renders nothing when disabled", () => {
    const { container } = render(<ContractCard state={{ enabled: false, reason: "x" }} propertyId="p" send={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the card, test-mode banner and a disabled Send until price and date are entered", () => {
    render(<ContractCard state={state()} propertyId="p" send={vi.fn()} />);
    expect(screen.getByTestId("send-contract-card")).toBeTruthy();
    expect(screen.getByTestId("contract-test-mode")).toBeTruthy();
    expect(sendBtn().disabled).toBe(true);
    expect(screen.getByTestId("contract-review-line").textContent).toContain("needed");
    fill();
    expect(sendBtn().disabled).toBe(false);
    expect(screen.getByTestId("contract-review-line").textContent).toContain("$210,000.00");
  });

  it("shows the live-mode banner when not in test mode", () => {
    render(<ContractCard state={state({ testMode: false })} propertyId="p" send={vi.fn()} />);
    expect(screen.getByTestId("contract-live-mode")).toBeTruthy();
  });

  it("review line shows legal description as needed and keeps Send disabled when the comp is low confidence", () => {
    const base = novationBase();
    render(<ContractCard state={state({ prefillBase: { ...base, comp: { ...freshComp(), confidence: "low" } } })} propertyId="p" send={vi.fn()} />);
    fill();
    expect(screen.getByTestId("contract-review-line").textContent).toContain("Legal description: needed");
    expect(sendBtn().disabled).toBe(true);
  });

  it("refuses to send with no title company or buyer entity configured (clear disabled state)", () => {
    render(<ContractCard state={state({ titleCompanies: [], selectedTitleCompanyId: null })} propertyId="p" send={vi.fn()} />);
    fill();
    expect(sendBtn().disabled).toBe(true);
    expect(screen.getByTestId("contract-blocked").textContent).toContain("Add a title company in Settings");
    cleanup();
    render(<ContractCard state={state({ buyerEntities: [], selectedBuyerEntityId: null })} propertyId="p" send={vi.fn()} />);
    fill();
    expect(sendBtn().disabled).toBe(true);
    expect(screen.getByTestId("contract-blocked").textContent).toContain("Add a buyer entity in Settings");
  });

  it("surfaces unsourced fields in More fields and blocks until filled", () => {
    const base = novationBase();
    render(<ContractCard state={state({ prefillBase: { ...base, comp: freshComp(), settings: { earnestMoneyCents: 50000, templateFieldDefaults: {} } } })} propertyId="p" send={vi.fn()} />);
    fill();
    expect(screen.getByTestId("contract-more-fields")).toBeTruthy();
    expect(sendBtn().disabled).toBe(true);
  });

  it("keeps the same send intent id across a double click and a lost response, and sends the typed economics", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce({ status: "sent", requestId: "r", offer: "logged" });
    render(<ContractCard state={state()} propertyId="p" send={send} />);
    fill();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("contract-status").textContent).toContain("response was lost"));
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].sendIntentId).toBe(send.mock.calls[0]![0].sendIntentId);
    expect(send.mock.calls[0]![0]).toMatchObject({ priceCents: 21000000, closingDate: "2099-01-02", earnestMoneyCents: 50000 });
    await waitFor(() => expect(screen.getByTestId("contract-status").textContent).toContain("Offer logged"));
    expect(sendBtn().disabled).toBe(true);
  });

  it("rotates the intent id after a definitive failure", async () => {
    const send = vi.fn().mockResolvedValue({ status: "failed", message: "nope" });
    render(<ContractCard state={state()} propertyId="p" send={send} />);
    fill();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByTestId("contract-status").textContent).toBe("nope"));
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].sendIntentId).not.toBe(send.mock.calls[0]![0].sendIntentId);
  });

  it("hides the Send button when the send is unconfirmed and says not to send again", async () => {
    const send = vi.fn().mockResolvedValue({ status: "unconfirmed", projectionId: "x" });
    render(<ContractCard state={state()} propertyId="p" send={send} />);
    fill();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.queryByTestId("contract-send")).toBeNull());
    expect(screen.getByTestId("contract-status").textContent).toContain("Do not send again");
  });

  it("shows the reconcile banner copy on an offer conflict", async () => {
    const send = vi.fn().mockResolvedValue({ status: "sent", requestId: "r", offer: "conflict" });
    render(<ContractCard state={state()} propertyId="p" send={send} />);
    fill();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByTestId("contract-status").textContent).toContain("offer needs reconciling"));
  });
});
