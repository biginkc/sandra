import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestPasswordReset, signIn, signInWithBmhId } = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
  signIn: vi.fn(),
  signInWithBmhId: vi.fn(),
}));

vi.mock("./actions", () => ({
  requestPasswordReset,
  signIn,
  signInWithBmhId,
}));

vi.mock("./login-background", () => ({
  // jsdom can't play <video>; the background is visual-only.
  LoginBackground: () => null,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("next=%2Fleads%2F5"),
}));

async function renderLoginPage(flag: string | undefined) {
  vi.stubEnv("NEXT_PUBLIC_BMH_ID_SSO", flag ?? "");
  vi.resetModules();
  const { default: LoginPage } = await import("./page");
  const view = render(<LoginPage />);
  // Let the page's Suspense boundary settle inside act() before asserting.
  // ("Forgot password?" only exists in the real form, not the fallback.)
  await screen.findByText(/forgot password/i);
  return view;
}

beforeEach(() => {
  signIn.mockResolvedValue(null);
  requestPasswordReset.mockResolvedValue({ ok: true, data: null });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("login page — BMH ID SSO", () => {
  it("hides the SSO button when the flag is off", async () => {
    await renderLoginPage(undefined);
    expect(
      screen.queryByRole("button", { name: /continue with bmh id/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the SSO button when the flag is on", async () => {
    await renderLoginPage("1");
    expect(
      screen.getByRole("button", { name: /continue with bmh id/i }),
    ).toBeInTheDocument();
  });

  it("passes the sanitized-on-the-server next value through the SSO form", async () => {
    let resolveSso: () => void = () => {};
    signInWithBmhId.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSso = resolve;
        }),
    );
    await renderLoginPage("1");

    fireEvent.click(
      screen.getByRole("button", { name: /continue with bmh id/i }),
    );

    await waitFor(() => expect(signInWithBmhId).toHaveBeenCalledTimes(1));
    const formData = signInWithBmhId.mock.calls[0][1] as FormData;
    expect(formData.get("next")).toBe("/leads/5");
    resolveSso();
  });

  it("locks both forms while SSO initiation is pending and blocks duplicate submits", async () => {
    let resolveSso: () => void = () => {};
    signInWithBmhId.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSso = resolve;
        }),
    );
    await renderLoginPage("1");

    const ssoButton = screen.getByRole("button", {
      name: /continue with bmh id/i,
    });
    fireEvent.click(ssoButton);

    // While the PKCE initiation is in flight, every path that could start
    // a second auth flow (and clobber the single verifier cookie) is off.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /redirecting/i }),
      ).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: /sign in/i })).toBeDisabled();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();

    // Rapid double-submit: clicking the (now disabled) button again must
    // not start a concurrent flow — disabled buttons have no activation
    // behavior, so no second form submission happens.
    fireEvent.click(screen.getByRole("button", { name: /redirecting/i }));
    expect(signInWithBmhId).toHaveBeenCalledTimes(1);

    resolveSso();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /continue with bmh id/i }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: /sign in/i })).toBeEnabled();
  });

  it("locks the SSO button while a password sign-in is pending", async () => {
    let resolveSignIn: (v: null) => void = () => {};
    signIn.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveSignIn = resolve;
        }),
    );
    await renderLoginPage("1");

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@bmhgroupkc.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "hunter22" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /signing in/i }),
      ).toBeDisabled(),
    );
    expect(
      screen.getByRole("button", { name: /continue with bmh id/i }),
    ).toBeDisabled();

    resolveSignIn(null);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /continue with bmh id/i }),
      ).toBeEnabled(),
    );
  });
});
