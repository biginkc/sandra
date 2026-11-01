import dns from "node:dns";

import { afterAll, beforeAll, expect, it } from "vitest";

import { assertStack, finishNoLiveClassifier, Receipt } from "./lib/env";
import { assertNoRealClassifierKeys, LIVE } from "./lib/no-live-classifier";
import { loadReplay, ProviderStubs } from "./lib/stubs";

/** Lib-level self-test of the no-live-classifier guard (no DB writes). */
const stubs = new ProviderStubs(loadReplay());
const R = new Receipt("G0-no-live-classifier-guard.txt");
beforeAll(() => { assertStack(); stubs.install(); });
afterAll(() => { stubs.uninstall(); finishNoLiveClassifier(); });

it("guard: keys, unserved Anthropic model, DNS bypass; stubbed Jev/Haiku still served", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "tsk_live_looking_value";
  expect(() => assertNoRealClassifierKeys()).toThrow(/non-stub value/);
  process.env.TYPESAFE_API_KEY = saved;
  const before = LIVE.attempts;
  await expect(fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-other", messages: [] }) })).rejects.toThrow(/live classifier call blocked/);
  await expect(dns.promises.lookup("api.typesafe.ai")).rejects.toThrow(/blocked/);
  await expect(new Promise((res, rej) => dns.lookup("api.anthropic.com", (e) => (e ? rej(e) : res(null))))).rejects.toThrow(/blocked/);
  const blocked = LIVE.attempts - before;
  const jev = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", body: JSON.stringify({ state: { homeowner_reply: "x" }, questions: { just_ok: { type: "noul" }, own_other_property: { type: "noul" } } }) });
  const haiku = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 200, stop_sequences: ["}"], messages: [{ content: "SELLER: hi" }] }) });
  R.line(`self-test: real-looking key rejected; blocked attempts counted = ${blocked} (unserved model, dns.promises, dns callback); stub-served Jev ${jev.status}, Haiku ${haiku.status}`);
  expect(blocked).toBe(3);
  expect(jev.status).toBe(200); expect(haiku.status).toBe(200);
  LIVE.attempts = before; // the deliberate attempts above are the self-test, not a lane's traffic
});
