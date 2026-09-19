import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callAction: vi.fn(),
  deletePropertiesBulk: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/lib/errors/call-action", () => ({ callAction: mocks.callAction }));
vi.mock("../actions", () => ({ deletePropertiesBulk: mocks.deletePropertiesBulk }));

import { DeleteLeadButton } from "./delete-lead-button";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deletePropertiesBulk.mockReturnValue("delete-action");
  mocks.callAction.mockResolvedValue({ ok: true });
  vi.stubGlobal("confirm", vi.fn(() => true));
});

describe("DeleteLeadButton", () => {
  it("returns an Acquisitions detail user to My Leads after deletion", async () => {
    render(
      <DeleteLeadButton
        propertyId="property-1"
        address="123 Main St"
        redirectHref="/my-leads"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete lead" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/my-leads"));
    expect(mocks.deletePropertiesBulk).toHaveBeenCalledWith(["property-1"]);
  });

  it("keeps the Leads fallback for existing callers", async () => {
    render(<DeleteLeadButton propertyId="property-1" address="123 Main St" />);

    fireEvent.click(screen.getByRole("button", { name: "Delete lead" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/leads"));
  });
});
