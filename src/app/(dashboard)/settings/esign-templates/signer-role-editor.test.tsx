import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SignerRoleEditor } from "./signer-role-editor";

describe("SignerRoleEditor", () => {
  it("keeps roles ordered and requires an explicit seller selection", () => {
    const onChange = vi.fn();
    render(
      <SignerRoleEditor
        roles={[
          { name: "Seller", order: 0 },
          { name: "Buyer", order: 1 },
        ]}
        sellerRoleName="Seller"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move Buyer up" }));
    expect(onChange).toHaveBeenCalledWith(
      [
        { name: "Buyer", order: 0 },
        { name: "Seller", order: 1 },
      ],
      "Seller",
    );

    fireEvent.click(screen.getByRole("radio", { name: "Buyer is the seller role" }));
    expect(onChange).toHaveBeenCalledWith(expect.any(Array), "Buyer");
    expect(screen.getByText(/Every role listed here must be assigned/i)).toBeVisible();
  });
});
