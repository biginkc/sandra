import type { ReactNode } from "react";

import { InitialEditorSessionProvider } from "./initial-editor-session";

export default function EsignTemplatesLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <InitialEditorSessionProvider>{children}</InitialEditorSessionProvider>
  );
}
