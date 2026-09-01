// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  navigateAuthorizedPopup,
  openAuthorizedPopup,
} from "./authorized-popup";

describe("authorized popup lifecycle", () => {
  it("installs no-referrer before fail-closed replacement navigation", () => {
    const events: string[] = [];
    const popup = popupWindow(events);
    vi.spyOn(window, "open").mockReturnValue(popup.window);

    const opened = openAuthorizedPopup();
    const navigated = navigateAuthorizedPopup(
      opened!,
      "https://authorized.example/document.pdf",
    );

    expect(navigated).toBe(true);
    expect(events).toEqual(["policy:no-referrer", "replace"]);
    expect(popup.window.opener).toBeNull();
    expect(popup.location.href).toBe("https://authorized.example/document.pdf");
  });

  it("fails closed and closes when the placeholder was already closed", () => {
    const popup = popupWindow([], { closed: true });

    expect(
      navigateAuthorizedPopup(popup.window, "https://authorized.example/file"),
    ).toBe(false);
    expect(popup.replace).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("catches replacement failures, closes the placeholder, and returns false", () => {
    const popup = popupWindow([], { replaceThrows: true });

    expect(
      navigateAuthorizedPopup(popup.window, "https://authorized.example/file"),
    ).toBe(false);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
});

function popupWindow(
  events: string[],
  options: { closed?: boolean; replaceThrows?: boolean } = {},
) {
  const location = { href: "about:blank" };
  const close = vi.fn();
  const replace = vi.fn((url: string) => {
    events.push("replace");
    if (options.replaceThrows) throw new Error("navigation denied");
    location.href = url;
  });
  const head = {
    append: vi.fn((meta: { content: string }) => {
      events.push(`policy:${meta.content}`);
    }),
  };
  const document = {
    head,
    createElement: vi.fn(() => ({ name: "", content: "" })),
  };
  const window = {
    opener: {},
    closed: options.closed ?? false,
    close,
    document,
    location: { replace },
  } as unknown as Window;
  return { window, location, close, replace };
}
