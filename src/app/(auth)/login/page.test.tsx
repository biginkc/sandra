import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { signInWithHugo } = vi.hoisted(() => ({ signInWithHugo: vi.fn() }));

vi.mock("./actions", () => ({ signInWithHugo }));
vi.mock("./login-background", () => ({ LoginBackground: () => null }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("next=%2Fleads%2F5"),
}));

async function renderLoginPage() {
  const { default: LoginPage } = await import("./page");
  render(<LoginPage />);
  await screen.findByRole("button", { name: /continue with hugo/i });
}

beforeEach(() => {
  signInWithHugo.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Hugo-only login page", () => {
  it("exposes only Continue with Hugo and no password or recovery controls", async () => {
    await renderLoginPage();
    expect(
      screen.getByRole("button", { name: /continue with hugo/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/forgot password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^sign in$/i)).not.toBeInTheDocument();
  });

  it("passes next to server-side sanitization", async () => {
    await renderLoginPage();
    fireEvent.click(screen.getByRole("button", { name: /continue with hugo/i }));

    await waitFor(() => expect(signInWithHugo).toHaveBeenCalledTimes(1));
    const submitted = signInWithHugo.mock.calls[0][1] as FormData;
    expect(submitted.get("next")).toBe("/leads/5");
  });

  it("locks the sole auth control and prevents duplicate PKCE starts", async () => {
    let resolveSso: () => void = () => {};
    signInWithHugo.mockImplementation(
      () => new Promise<void>((resolve) => { resolveSso = resolve; }),
    );
    await renderLoginPage();

    fireEvent.click(screen.getByRole("button", { name: /continue with hugo/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /opening hugo/i })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /opening hugo/i }));
    expect(signInWithHugo).toHaveBeenCalledTimes(1);

    resolveSso();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /continue with hugo/i }),
      ).toBeEnabled(),
    );
  });
});
