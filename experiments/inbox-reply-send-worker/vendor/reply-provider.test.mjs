import { strict as assert } from "node:assert";
import test from "node:test";
import { createSendilloReplyTransport } from "./reply-provider.mjs";

const reply = { from: "+18165550001", to: "+18165550002", body: "Exact approved text" };
const env = { INBOX_REPLY_OWNED_RECIPIENTS: reply.to };
const signal = () => new AbortController().signal;

test("fails closed for an unowned recipient before the injected transport is called", async () => {
  let calls = 0;
  const transport = async () => { calls += 1; return Response.json({ data: { messageId: "should-not-exist" } }); };
  const send = createSendilloReplyTransport("synthetic-key", transport, env);
  assert.deepEqual(await send({ ...reply, to: "+18165550003" }, signal()), { kind: "not_attempted", reason: "invalid_input" });
  assert.equal(calls, 0);
});

test("rejects an unset, empty, or malformed allowlist at construction", () => {
  for (const raw of [undefined, "", "not-a-phone", "+18165550002,,+18165550003"]) {
    assert.throws(() => createSendilloReplyTransport("synthetic-key", async () => Response.json({}), { INBOX_REPLY_OWNED_RECIPIENTS: raw }), /allowlist/);
  }
});

test("allows an owned recipient and still uses the injected transport", async () => {
  let calls = 0;
  const transport = async () => { calls += 1; return Response.json({ data: { messageId: "owned-reference", status: "queued" } }); };
  const result = await createSendilloReplyTransport("synthetic-key", transport, env)(reply, signal());
  assert.deepEqual(result, { kind: "accepted", provider: "sendillo", externalId: "owned-reference", providerStatus: "queued" });
  assert.equal(calls, 1);
});
