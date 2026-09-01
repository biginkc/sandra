"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
} from "react";

import type { EmbeddedTemplateSession } from "./types";

type InitialEditorSessionStore = Readonly<{
  put(templateId: string, session: EmbeddedTemplateSession): void;
  take(templateId: string): EmbeddedTemplateSession | null;
}>;

const InitialEditorSessionContext =
  createContext<InitialEditorSessionStore | null>(null);

export function InitialEditorSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const sessions = useRef(new Map<string, EmbeddedTemplateSession>());
  const store = useMemo<InitialEditorSessionStore>(
    () => ({
      put(templateId, session) {
        sessions.current.clear();
        sessions.current.set(templateId, session);
      },
      take(templateId) {
        const session = sessions.current.get(templateId) ?? null;
        sessions.current.delete(templateId);
        return session;
      },
    }),
    [],
  );

  return (
    <InitialEditorSessionContext.Provider value={store}>
      {children}
    </InitialEditorSessionContext.Provider>
  );
}

export function useInitialEditorSessionStore() {
  const store = useContext(InitialEditorSessionContext);
  if (!store) throw new Error("InitialEditorSessionProvider is missing.");
  return store;
}
