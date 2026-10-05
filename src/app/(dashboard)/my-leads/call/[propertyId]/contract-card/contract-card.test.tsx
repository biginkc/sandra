import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContractCard, shouldRotateIntent } from "./contract-card";
import { BUYER, novationBase, TEST_ONLY_EARNEST_MONEY_CENTS, TITLE } from "./fixtures";
import type { ContractCardState } from "../types";

afterEach(cleanup);

const freshComp = () => ({ ...novationBase().comp!, fetchedAt: new Date(Date.now() - 86400000).toISOString() });
const state = (over: Record<string, unknown> = {}): ContractCardState => ({
  enabled: true, testMode: true, templateId: "t", sellerRoleName: "Seller",
  signerRoles: [{ name: "Seller", order: 0 }, { name: "Buyer", order: 1 }],
  sellerSigner: { name: "Sam Seller", emailAddress: "sam@example.test" },
  prefillBase: { ...novationBase(), comp: freshComp() },
  titleCompanies: [TITLE], buyerEntities: [BUYER],
  todayCentral: "2026-10-04", tomorrowCentral: "2026-10-05", ...over,
}) as ContractCardState;

const fill = () => {
  fireEvent.change(screen.getByTestId("contract-price"), { target: { value: "210000" } });
  fireEvent.change(screen.getByTestId("contract-closing-date"), { target: { value: "2099-01-02" } });
  // Nothing is preselected and earnest money has no default: the rep picks (or types) all three per contract.
  fireEvent.change(screen.getByTestId("contract-title-company"), { target: { value: TITLE.id } });
  fireEvent.change(screen.getByTestId("contract-buyer-entity"), { target: { value: BUYER.id } });
  fireEvent.change(screen.getByTestId("contract-earnest"), { target: { value: (TEST_ONLY_EARNEST_MONEY_CENTS / 100).toFixed(2) } });
};
const sendBtn = () => screen.getByTestId("contract-send") as HTMLButtonElement;

describe("ContractCard starts blank", () => {
  it("nothing is preselected and earnest money is empty even when the org has saved lists", () => {
    render(<ContractCard state={state()} propertyId="p" send={vi.fn()} />);
    expect((screen.getByTestId("contract-title-company") as HTMLSelectElement).value).toBe("");
    expect((screen.getByTestId("contract-buyer-entity") as HTMLSelectElement).value).toBe("");
    expect((screen.getByTestId("contract-earnest") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("contract-send") as HTMLButtonElement).disabled).toBe(true);
  });
  it("stays refused until each of title company, buyer entity and earnest money has a value", () => {
    render(<ContractCard state={state()} propertyId="p" send={vi.fn()} />);
    const btn = () => screen.getByTestId("contract-send") as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("contract-price"), { target: { value: "210000" } });
    fireEvent.change(screen.getByTestId("contract-closing-date"), { target: { value: "2099-01-02" } });
    fireEvent.change(screen.getByTestId("contract-title-company"), { target: { value: TITLE.id } });
    fireEvent.change(screen.getByTestId("contract-buyer-entity"), { target: { value: BUYER.id } });
    expect(btn().disabled).toBe(true); // earnest empty
    fireEvent.change(screen.getByTestId("contract-earnest"), { target: { value: "100" } });
    expect(btn().disabled).toBe(false);
    fireEvent.change(screen.getByTestId("contract-title-company"), { target: { value: "" } });
    expect(btn().disabled).toBe(true);
  });
});

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

  it("stays disabled with no saved title company or buyer entity until each has a value (typed or picked)", () => {
    render(<ContractCard state={state({ titleCompanies: [], buyerEntities: [] })} propertyId="p" send={vi.fn()} />);
    fill();
    expect(sendBtn().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("contract-title-company"), { target: { value: "__new__" } });
    expect(sendBtn().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("contract-title-new-name"), { target: { value: "Typed Title" } });
    expect(sendBtn().disabled).toBe(true); // closing agent still empty
    fireEvent.change(screen.getByTestId("contract-title-new-closingAgentName"), { target: { value: "Agent A" } });
    fireEvent.change(screen.getByTestId("contract-title-new-closingAgentPhone"), { target: { value: "555-0100" } });
    fireEvent.change(screen.getByTestId("contract-title-new-closingAgentAddress"), { target: { value: "1 Test St" } });
    expect(sendBtn().disabled).toBe(true); // buyer still empty
    fireEvent.change(screen.getByTestId("contract-buyer-entity"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByTestId("contract-buyer-new-name"), { target: { value: "Typed Buyer LLC" } });
    expect(sendBtn().disabled).toBe(true); // buyer signer needs an email
    fireEvent.change(screen.getByTestId("contract-buyer-new-email"), { target: { value: "b@example.test" } });
    fireEvent.change(screen.getByTestId("contract-buyer-new-attorneyInFact"), { target: { value: "Test Attorney" } });
    fireEvent.change(screen.getByTestId("contract-buyer-new-phone"), { target: { value: "555-0101" } });
    expect(sendBtn().disabled).toBe(false);
  });

  it("sends typed title company and buyer entity inline with empty ids", async () => {
    const send = vi.fn(async () => ({ status: "sent" as const, requestId: "r", offer: "pending" as const }));
    render(<ContractCard state={state({ titleCompanies: [], buyerEntities: [] })} propertyId="p" send={send} />);
    fill();
    fireEvent.change(screen.getByTestId("contract-title-company"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByTestId("contract-title-new-name"), { target: { value: "Typed Title" } });
    fireEvent.change(screen.getByTestId("contract-title-new-closingAgentName"), { target: { value: "Agent A" } });
    fireEvent.change(screen.getByTestId("contract-title-new-closingAgentPhone"), { target: { value: "555-0100" } });
    fireEvent.change(screen.getByTestId("contract-title-new-closingAgentAddress"), { target: { value: "1 Test St" } });
    fireEvent.change(screen.getByTestId("contract-buyer-entity"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByTestId("contract-buyer-new-name"), { target: { value: "Typed Buyer LLC" } });
    fireEvent.change(screen.getByTestId("contract-buyer-new-email"), { target: { value: "b@example.test" } });
    fireEvent.change(screen.getByTestId("contract-buyer-new-attorneyInFact"), { target: { value: "Test Attorney" } });
    fireEvent.change(screen.getByTestId("contract-buyer-new-phone"), { target: { value: "555-0101" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({
      titleCompanyId: "", buyerEntityId: "",
      titleCompanyNew: { name: "Typed Title", closingAgentName: "Agent A" },
      buyerEntityNew: { name: "Typed Buyer LLC", email: "b@example.test" },
    });
  });

  it("with earnest money unset the field is empty and Send stays disabled until the rep types it", async () => {
    const base = novationBase();
    const send = vi.fn().mockResolvedValue({ status: "failed", message: "x" });
    render(<ContractCard state={state({ prefillBase: { ...base, comp: freshComp(), settings: { earnestMoneyCents: null, templateFieldDefaults: base.settings.templateFieldDefaults } } })} propertyId="p" send={send} />);
    fill();
    fireEvent.change(screen.getByTestId("contract-earnest"), { target: { value: "" } });
    expect((screen.getByTestId("contract-earnest") as HTMLInputElement).value).toBe("");
    expect(sendBtn().disabled).toBe(true);
    expect(screen.getByTestId("contract-blocked").textContent).toContain("Enter the earnest money amount");
    fireEvent.change(screen.getByTestId("contract-earnest"), { target: { value: "100" } });
    expect(sendBtn().disabled).toBe(false);
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].earnestMoneyCents).toBe(10000);
  });

  it("surfaces unsourced fields in More fields and blocks until filled", () => {
    const base = novationBase();
    render(<ContractCard state={state({ prefillBase: { ...base, comp: freshComp(), settings: { earnestMoneyCents: TEST_ONLY_EARNEST_MONEY_CENTS, templateFieldDefaults: {} } } })} propertyId="p" send={vi.fn()} />);
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
    expect(send.mock.calls[0]![0]).toMatchObject({ priceCents: 21000000, closingDate: "2099-01-02", earnestMoneyCents: TEST_ONLY_EARNEST_MONEY_CENTS });
    await waitFor(() => expect(screen.getByTestId("contract-status").textContent).toContain("Offer logged"));
    expect(sendBtn().disabled).toBe(true);
  });

  it("rotates the intent id after a definitive failure", async () => {
    const send = vi.fn().mockResolvedValue({ status: "failed", message: "nope", definitive: true });
    render(<ContractCard state={state()} propertyId="p" send={send} />);
    fill();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByTestId("contract-status").textContent).toBe("nope"));
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].sendIntentId).not.toBe(send.mock.calls[0]![0].sendIntentId);
  });

  it("keeps the SAME intent id after a non-definitive failure (e.g. a server error after the send step)", async () => {
    const send = vi.fn().mockResolvedValue({ status: "failed", message: "The contract could not be sent. Please retry." });
    render(<ContractCard state={state()} propertyId="p" send={send} />);
    fill();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByTestId("contract-status").textContent).toContain("Please retry"));
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].sendIntentId).toBe(send.mock.calls[0]![0].sendIntentId);
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

describe("intent id rotation by last result state", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["no result yet", null, true],
    ["blocked", { status: "blocked", code: "MISSING_FIELDS", message: "m" }, true],
    ["blocked IDEMPOTENCY_CONFLICT", { status: "blocked", code: "IDEMPOTENCY_CONFLICT", message: "m" }, false],
    ["blocked FORBIDDEN", { status: "blocked", code: "FORBIDDEN", message: "m" }, false],
    ["definitive failure", { status: "failed", message: "m", definitive: true }, true],
    ["non-definitive failure", { status: "failed", message: "m" }, false],
    ["lost response (client-synthesised failure)", { status: "failed", message: "The response was lost." }, false],
    ["sent", { status: "sent", requestId: "r", offer: "pending" }, false],
    ["unconfirmed", { status: "unconfirmed", projectionId: "x" }, false],
  ];

  it.each(cases)("helper: %s -> rotate=%s", (_n, result, rotate) => {
    expect(shouldRotateIntent(result as never, false)).toBe(rotate);
  });
  it("never rotates while a send is in flight", () => {
    expect(shouldRotateIntent(null, true)).toBe(false);
  });

  // End to end: send (result), edit a field, send again; is the intent reused?
  it.each(cases.filter(([, r]) => r !== null && (r as { status: string }).status !== "sent" && (r as { status: string }).status !== "unconfirmed"))(
    "edit then Send after %s reuses the intent: %s",
    async (_n, result, rotate) => {
      const send = vi.fn().mockResolvedValueOnce(result).mockResolvedValue({ status: "failed", message: "again" });
      render(<ContractCard state={state()} propertyId="p" send={send} />);
      fill();
      fireEvent.click(sendBtn());
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("contract-status")).toBeTruthy());
      fireEvent.change(screen.getByTestId("contract-price"), { target: { value: "199000" } });
      fireEvent.click(sendBtn());
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      const same = send.mock.calls[1]![0].sendIntentId === send.mock.calls[0]![0].sendIntentId;
      expect(same).toBe(!rotate);
    },
  );

  it("edit after a thrown (lost) response reuses the intent", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValue({ status: "failed", message: "x" });
    render(<ContractCard state={state()} propertyId="p" send={send} />);
    fill();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByTestId("contract-status").textContent).toContain("response was lost"));
    fireEvent.change(screen.getByTestId("contract-closing-date"), { target: { value: "2099-02-03" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].sendIntentId).toBe(send.mock.calls[0]![0].sendIntentId);
  });
});

describe("ContractCard projection state", () => {
  const proj = (over: Record<string, unknown>) => ({ id: "p1", state: "pending", conflictCode: null, requestId: "r1", sendUnknown: false, amountCents: 100, followUpAt: null, pendingOfferAmountCents: null, ...over });
  const recovery = { retry: vi.fn(), supersede: vi.fn(), reassign: vi.fn(), cancel: vi.fn() };

  it("hides the send form while a contract is open, so a reload cannot offer a second send", () => {
    for (const p of [proj({ state: "awaiting_send" }), proj({ state: "pending" }), proj({ state: "logged", followUpAt: "2026-11-02T15:00:00Z" }), proj({ state: "conflict", conflictCode: "STALE_STATE" })]) {
      const { unmount } = render(<ContractCard state={state({ projection: p })} propertyId="p" send={vi.fn()} recovery={recovery} />);
      expect(screen.queryByTestId("contract-send")).toBeNull();
      unmount();
    }
  });

  it("maps projection state to the status copy", () => {
    const copy = (p: Record<string, unknown>) => {
      const { unmount } = render(<ContractCard state={state({ projection: p })} propertyId="p" send={vi.fn()} recovery={recovery} />);
      const text = screen.getByTestId("contract-status").textContent;
      unmount();
      return text;
    };
    expect(copy(proj({ state: "awaiting_send", sendUnknown: true }))).toBe("Send unconfirmed. Sandra is checking with Dropbox Sign. Do not send again.");
    expect(copy(proj({ state: "pending" }))).toBe("Contract sent. Logging the offer…");
    expect(copy(proj({ state: "logged", followUpAt: "2026-11-02T15:00:00Z" }))).toBe("Contract sent. Offer logged. Follow-up Nov 2, 2026.");
  });

  it("a conflict shows the recovery banner with its actions", () => {
    render(<ContractCard state={state({ projection: proj({ state: "conflict", conflictCode: "PENDING_OFFER_EXISTS", pendingOfferAmountCents: 5 }) })} propertyId="p" send={vi.fn()} recovery={recovery} />);
    expect(screen.getByRole("alert").textContent).toBe("Contract sent, offer needs reconciling");
    expect(screen.getByTestId("recovery-supersede")).toBeTruthy();
  });

  it("failed and cancelled projections show the form again with a note (new intent)", () => {
    const { unmount } = render(<ContractCard state={state({ projection: proj({ state: "cancelled" }) })} propertyId="p" send={vi.fn()} />);
    expect(screen.getByTestId("contract-prior-cancelled").textContent).toBe("Contract cancelled.");
    expect(screen.getByTestId("contract-send")).toBeTruthy();
    unmount();
  });

  it("offers motivation only when the lead has none; it is optional and sent when supplied", async () => {
    const send = vi.fn(async () => ({ status: "sent" as const, requestId: "r", offer: "pending" as const }));
    const { unmount } = render(<ContractCard state={state({ motivationRecorded: true })} propertyId="p" send={send} />);
    expect(screen.queryByTestId("contract-motivation")).toBeNull();
    unmount();
    render(<ContractCard state={state({ motivationRecorded: false })} propertyId="p" send={send} />);
    fill();
    expect(sendBtn().disabled).toBe(false);
    fireEvent.change(screen.getByTestId("contract-motivation-kind"), { target: { value: "no_motivation" } });
    expect(sendBtn().disabled).toBe(false);
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({ motivation: { kind: "no_motivation", text: null }, temperature: null });
  });

  it("sends without a motivation when none is entered", async () => {
    const send = vi.fn(async () => ({ status: "sent" as const, requestId: "r", offer: "pending" as const }));
    render(<ContractCard state={state({ motivationRecorded: false })} propertyId="p" send={send} />);
    fill();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect((send.mock.calls[0] as unknown[])[0]).not.toHaveProperty("motivation");
  });

  it("polls through onRefresh while the contract is being confirmed", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    render(<ContractCard state={state({ projection: proj({ state: "pending" }) })} propertyId="p" send={vi.fn()} onRefresh={refresh} />);
    vi.advanceTimersByTime(10_500);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
