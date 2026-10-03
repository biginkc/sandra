import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { resetSubmissionStoreForTests } from "./src/app/(dashboard)/my-leads/_components/submission-store";

// jsdom doesn't fully wire window.localStorage. Install a minimal in-memory
// Storage shim so components that read/write localStorage on mount can be
// rendered without crashing. Cleared between tests via afterEach.
const store = new Map<string, string>();
const ls: Storage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (key) => (store.has(key) ? (store.get(key) ?? null) : null),
  key: (index) => Array.from(store.keys())[index] ?? null,
  removeItem: (key) => {
    store.delete(key);
  },
  setItem: (key, value) => {
    store.set(key, String(value));
  },
};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  get: () => ls,
});

Element.prototype.scrollIntoView ??= vi.fn();

afterEach(() => {
  cleanup();
  store.clear();
  // A save record must never leak from one test into the next.
  resetSubmissionStoreForTests();
  vi.clearAllMocks();
});
