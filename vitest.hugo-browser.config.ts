import { defineConfig } from "vitest/config";
import base from "./vitest.config";
export default defineConfig({ ...base, test: {
  ...base.test, include: ["tests/hugo-session/browser.test.ts"], fileParallelism: false,
} });
