import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestPasswordReset, signIn, signInWithHugo } = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
  signIn: vi.fn(),
  signInWithHugo: vi.fn(),
}));

vi.mock("./actions", () => ({ requestPasswordReset, signIn, signInWithHugo }));
vi.mock("./login-background", () => ({ LoginBackground: () => null }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("next=%2Fleads%2F5"),
}));

async function renderPage() {
  const { default: LoginPage } = await import("./page");
  render(<LoginPage />);
}

async function renderLoginPage() {
  await renderPage();
  await screen.findByRole("button", { name: /sign in with hugo/i });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "1");
  signIn.mockResolvedValue({ ok: true, data: null });
  signInWithHugo.mockResolvedValue(undefined);
  requestPasswordReset.mockResolvedValue({ ok: true, data: null });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Hugo-only login page", () => {
  it("exposes only Continue with Hugo and no password or recovery controls", async () => {
    await renderLoginPage();
    expect(
      screen.getByRole("button", { name: /sign in with hugo/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/forgot password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^sign in$/i)).not.toBeInTheDocument();
  });

  it("passes next to server-side sanitization", async () => {
    await renderLoginPage();
    fireEvent.click(screen.getByRole("button", { name: /sign in with hugo/i }));

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

    fireEvent.click(screen.getByRole("button", { name: /sign in with hugo/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /opening hugo/i })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /opening hugo/i }));
    expect(signInWithHugo).toHaveBeenCalledTimes(1);

    resolveSso();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /sign in with hugo/i }),
      ).toBeEnabled(),
    );
  });

  it("keeps the existing password login usable while Hugo is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
    await renderPage();

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /forgot password/i }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /sign in with hugo/i }),
    ).not.toBeInTheDocument();
  });

  it("restores password recovery only while Hugo is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_HUGO_SSO", "");
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: /forgot password/i }));

    expect(screen.getByText(/send a password-reset link/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send link/i })).toBeEnabled();
  });
});
