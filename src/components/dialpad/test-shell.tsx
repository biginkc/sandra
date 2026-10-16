import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { CallLockProvider } from "@/components/calls/call-lock-context";
import { DialpadCallProvider } from "./dialpad-call-provider";

/** Test-only: the persistent layout owners (call lock + Dialpad provider) around a page under test. */
export function DialpadTestShell({ children }: { children: ReactNode }) {
  return (
    <CallLockProvider>
      <DialpadCallProvider enabled>{children}</DialpadCallProvider>
    </CallLockProvider>
  );
}

export function renderWithDialpad(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { wrapper: DialpadTestShell, ...options });
}
