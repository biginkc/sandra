/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// CLI: preflight | setup | f1..f7 | teardown. DRY-RUN BY DEFAULT.
// Live mode needs --live AND a typed confirmation. The tunnel is started separately
// (so TELNYX_API_KEY is not inherited by it). Nothing here spawns child processes.
import path from "node:path";
import readline from "node:readline";
import { loadConfig, describeConfig, type Config } from "./env";
import { Inventory } from "./inventory";
import { Budget } from "./budget";
import { EventLog } from "./event-log";
import { TelnyxClient } from "./telnyx-client";
import { runPreflight } from "./preflight";
import { randomBytes } from "node:crypto";
import { runSetup, assertReady } from "./setup";
import { ProbeGate } from "./probe-gate";
import { makeLegReconciler } from "./leg-reconcile";
import { runTeardown } from "./teardown";
import { startServer } from "./webhook-server";
import { FLOWS } from "./flows";

export const CONFIRM_PHRASE = "I CONFIRM LIVE TELNYX TEST";
const RUN_DIR = path.join(__dirname, ".run");

/** Env passed to any child process must never carry the API key or the 1Password token. */
export function childEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { TELNYX_API_KEY: _a, OP_SERVICE_ACCOUNT_TOKEN: _b, ...rest } = env;
  return rest;
}

export function parseArgs(argv: string[]): { cmd?: string; live: boolean } {
  return { cmd: argv.find((a) => !a.startsWith("--")), live: argv.includes("--live") };
}

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

async function main(): Promise<void> {
  const { cmd, live } = parseArgs(process.argv.slice(2));
  const valid = ["preflight", "setup", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "teardown"];
  if (!cmd || !valid.includes(cmd)) {
    console.log(`usage: tsx run.ts <${valid.join("|")}> [--live]   (dry-run unless --live)`);
    process.exit(1);
  }
  let cfg: Config;
  if (live) cfg = loadConfig();
  else {
    // Dry-run still needs structurally valid config, but never uses the key.
    cfg = loadConfig({ ...process.env, TELNYX_API_KEY: process.env.TELNYX_API_KEY || "dry-run" });
  }
  console.log(describeConfig(cfg));
  if (live) {
    if (!process.stdin.isTTY) throw new Error("live mode needs an interactive terminal");
    const typed = await ask(`Live run of "${cmd}" will make real Telnyx calls. Type exactly "${CONFIRM_PHRASE}": `);
    if (typed.trim() !== CONFIRM_PHRASE) throw new Error("confirmation not given; nothing was run");
  } else console.log("DRY-RUN: no network calls will be made. Use --live to run for real.");

  const inv = new Inventory(RUN_DIR);
  const budget = new Budget(cfg.limits, RUN_DIR);
  const log = new EventLog(RUN_DIR);
  const client = new TelnyxClient({ config: cfg, inventory: inv, dryRun: !live, budget });

  if (cmd === "preflight") await runPreflight(client, inv, cfg);
  else if (cmd === "setup") await runSetup(client, inv, cfg);
  else if (cmd === "teardown") await runTeardown({ client, inv, cfg, log, budget });
  else {
    if (!live) { console.log(`dry-run: would run ${cmd} (requires setup, a running tunnel and the browser page)`); return; }
    const stats = { startFrames: [] as unknown[], bytesByTrack: {} as Record<string, number> };
    const streamToken = randomBytes(24).toString("base64url");
    const ensureReady = () => assertReady(client, inv, cfg);
    // Refuse before anything is served or dialed unless setup's read-back passed and still holds.
    await ensureReady();
    const sourceLegs: string[] = []; // owned transfer-source call(s); not probe legs
    const legReconciler = makeLegReconciler(client, inv, log);
    const probeGate = new ProbeGate({
      budget, log,
      protectedLegs: () => sourceLegs,
      browserLegBoundSecs: () => { const n = Number(inv.getRole("browserLegBoundSecs")); return Number.isFinite(n) && n > 0 ? n : undefined; },
      ...legReconciler,
      targets: () => [
        { label: "owned phone (PSTN)", target: cfg.testPhones[0] },
        ...(inv.getRole("escapeSipUsername") ? [{ label: "on-account SIP", target: `sip:${inv.getRole("escapeSipUsername")}@sip.telnyx.com` }] : []),
        ...cfg.devSipEndpoints.map((e) => ({ label: "external dev SIP", target: e })),
      ],
    });
    const server = startServer({
      publicKeyBase64: cfg.publicKey, log, stats, probeGate, streamToken,
      getBrowserToken: async () => {
        await ensureReady(); // re-verify provider settings before every token issuance
        const id = inv.getRole("browserCredentialId");
        if (!id) throw new Error("run setup first");
        const t = await client.request<string>("POST", `/telephony_credentials/${id}/token`);
        return { token: typeof t === "string" ? t : String((t as any).data ?? ""), sipUsername: inv.getRole("browserSipUsername") ?? "" };
      },
    }, Number(process.env.DIRECT_CALL_LOCAL_PORT ?? 8787));
    console.log("Local server on http://localhost:8787 (open this in the browser). Point your separately started tunnel at it.");
    try {
      await FLOWS[cmd]({ client, inv, cfg, log, stats, streamToken, probeGate, sourceLegs, ensureReady, ask, say: console.log });
    } finally {
      server.close();
    }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
