import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({test:{include:["experiments/inbox-operation-domain/sender-proof.test.ts"],environment:"node"},resolve:{alias:{"@":path.resolve("src"),"server-only":path.resolve("node_modules/server-only/empty.js")}}});
