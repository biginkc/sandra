import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./softphone-provider", () => ({
  useOptionalSoftphone: () => ({
    openLead: vi.fn(),
    callingEnabled: true,
  }),
}));

import { SoftphoneLeadButton } from "./softphone-lead-button";

describe("<SoftphoneLeadButton />", () => {
  it("keeps the compact lead call target at least 36 pixels square", () => {
    render(
      <SoftphoneLeadButton
        compact
        lead={{
          id: "property-1",
          contactId: "contact-1",
          firstName: "Seller",
          name: "Seller",
          address: "1 Main St",
          state: "MO",
          phones: ["+18165550123"],
          dncLocked: false,
          contactDnc: false,
          callable: true,
        }}
      />,
    );

    expect(screen.getByTestId("call-lead-button")).toHaveClass("size-9");
  });
});
