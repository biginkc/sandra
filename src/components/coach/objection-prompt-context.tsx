"use client";

import { createContext, useContext, type ReactNode } from "react";

const ObjectionPromptContext = createContext(false);

export function ObjectionPromptProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <ObjectionPromptContext.Provider value={enabled}>{children}</ObjectionPromptContext.Provider>;
}

export function useObjectionPromptEnabled(): boolean {
  return useContext(ObjectionPromptContext);
}
