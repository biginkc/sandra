"use client";

import type { ReactNode } from "react";
import { BlockOptionsContext, type BlockOptions } from "./blocks/_block-shell";

export function BlockOptionsProvider({
  value,
  children,
}: {
  value: BlockOptions;
  children: ReactNode;
}) {
  return (
    <BlockOptionsContext.Provider value={value}>
      {children}
    </BlockOptionsContext.Provider>
  );
}
