import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const a = vi.hoisted(() => ({
  saveTitleCompanyAction: vi.fn(),
  deleteTitleCompanyAction: vi.fn(),
  saveBuyerEntityAction: vi.fn(),
  deleteBuyerEntityAction: vi.fn(),
  saveMarketDefaultAction: vi.fn(),
  deleteMarketDefaultAction: vi.fn(),
  saveContractSettingsAction: vi.fn(),
}));
vi.mock("./actions", () => a);

import { ContractDefaultsForm, type ContractDefaultsInitial } from "./form";

const empty: ContractDefaultsInitial = {
  titleCompanies: [],
  buyerEntities: [],
  marketDefaults: [],
  settings: {
    earnestMoney: "",
    followUpDays: 3,
    followUpHour: 9,
    defaultTitleCompanyId: null,
    defaultBuyerEntityId: null,
    templateFieldDefaultsText: "",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const f of Object.values(a)) f.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("ContractDefaultsForm", () => {
  it("starts empty with a blank earnest money field and disabled save", () => {
    render(<ContractDefaultsForm initial={empty} />);
    const earnest = screen.getByLabelText(/earnest money/i) as HTMLInputElement;
    expect(earnest.value).toBe("");
    expect(earnest.placeholder).toBe("");
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/follow-up days/i) as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText(/follow-up hour/i) as HTMLInputElement).value).toBe("9");
  });

  it("saves settings once earnest money is typed", async () => {
    render(<ContractDefaultsForm initial={empty} />);
    fireEvent.change(screen.getByLabelText(/earnest money/i), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(a.saveContractSettingsAction).toHaveBeenCalled());
    expect(a.saveContractSettingsAction.mock.calls[0][0]).toMatchObject({ earnestMoney: "7", followUpDays: 3, followUpHour: 9 });
  });

  it("blocks save and shows the error for an economic template default", () => {
    render(<ContractDefaultsForm initial={empty} />);
    fireEvent.change(screen.getByLabelText(/earnest money/i), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText(/template field defaults/i), { target: { value: "offer_price=1" } });
    expect(screen.getByRole("alert").textContent).toMatch(/offer_price/);
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds a title company and shows server errors", async () => {
    a.saveTitleCompanyAction.mockResolvedValueOnce({ ok: false, message: "nope" });
    render(<ContractDefaultsForm initial={empty} />);
    fireEvent.change(screen.getByLabelText(/title company name/i), { target: { value: "T" } });
    fireEvent.change(screen.getByLabelText(/closing agent name/i), { target: { value: "C" } });
    fireEvent.click(screen.getByRole("button", { name: "Add title company" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("nope"));
    expect(a.saveTitleCompanyAction.mock.calls[0][0]).toMatchObject({ name: "T", closingAgentName: "C", isActive: true });
  });
});
