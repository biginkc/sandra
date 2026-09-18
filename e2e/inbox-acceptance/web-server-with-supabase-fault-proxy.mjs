import { spawn } from "node:child_process";
import { startSupabaseFaultProxy } from "./supabase-fault-proxy.mjs";

const targetUrl = process.env.INBOX_ACCEPTANCE_SUPABASE_TARGET_URL;
const port = Number(process.env.INBOX_ACCEPTANCE_FAULT_PROXY_PORT ?? "4567");
const token = process.env.INBOX_ACCEPTANCE_FAULT_PROXY_TOKEN;
if (!targetUrl || !token) throw new Error("Acceptance Supabase proxy configuration is incomplete.");

const proxy = await startSupabaseFaultProxy({ targetUrl, port, token });
const nextEnv = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: proxy.origin };
const nextArgs = ["next", "dev", ...(process.env.INBOX_ACCEPTANCE_NEXT_USE_WEBPACK === "1" ? ["--webpack"] : []), "-p", "3456"];
const next = spawn("npx", nextArgs, { env: nextEnv, stdio: "inherit" });
let shuttingDown = false;
const close = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (next.exitCode === null) next.kill(signal);
  await proxy.close();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { void close(signal); });
}
next.once("exit", async (code, signal) => {
  await proxy.close();
  process.exit(signal ? 1 : (code ?? 1));
});

