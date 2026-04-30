import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, expect, vi } from "vitest";

import { CreateSequenceForm } from "./form";

const push = vi.fn();
const createSequence = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (...args: unknown[]) => push(...args),
    refresh: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/sequences/new",
}));

vi.mock("../actions", () => ({
  createSequence: (...args: unknown[]) => createSequence(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  push.mockReset();
  createSequence.mockReset();
});

describe("<CreateSequenceForm />", () => {
  it("disables Create until a name is entered, then submits with the form payload and routes to the new editor", async () => {
    const user = userEvent.setup();
    createSequence.mockResolvedValue({ ok: true, data: { id: "seq-new" } });

    render(<CreateSequenceForm />);

    const create = screen.getByRole("button", { name: /^create$/i });
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText(/name/i), "RTL smoke");
    await user.type(
      screen.getByLabelText(/description/i),
      "created by rtl",
    );
    expect(create).toBeEnabled();

    await user.click(create);

    expect(createSequence).toHaveBeenCalledTimes(1);
    expect(createSequence).toHaveBeenCalledWith({
      name: "RTL smoke",
      description: "created by rtl",
      append_opt_out: true,
    });
    expect(push).toHaveBeenCalledWith("/sequences/seq-new/edit");
  });

  it("does not redirect when the action fails", async () => {
    const user = userEvent.setup();
    createSequence.mockResolvedValue({
      ok: false,
      error: { code: "DUPLICATE_NAME", message: "already exists" },
    });

    render(<CreateSequenceForm />);

    await user.type(screen.getByLabelText(/name/i), "Dup");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(createSequence).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
