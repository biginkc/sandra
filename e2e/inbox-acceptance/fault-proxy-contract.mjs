import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { startSupabaseFaultProxy } from "./supabase-fault-proxy.mjs";

test("initial queue fault reaches the real client; explicit retry succeeds", async () => {
  let forwarded = 0;
  const upstream = http.createServer((_request, response) => {
    forwarded += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const token = "owned-loopback-queue-fault-test-token";
  let proxy;
  try {
    proxy = await startSupabaseFaultProxy({
      targetUrl: `http://127.0.0.1:${upstream.address().port}`,
      port,
      token,
    });
    const armed = await fetch(`${proxy.origin}/__inbox-fault/arm-o10`, {
      method: "POST", headers: { "x-inbox-fault-token": token },
    });
    assert.equal(armed.status, 204);
    const client = createClient(proxy.origin, "local-placeholder", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const read = () => client.from("messages")
      .select("id,property:properties(id),contact:contacts(id)")
      .eq("status", "queued").limit(101);
    const first = await read();
    assert.equal(first.error?.code, "O10_INJECTED_QUEUE_READ_FAILURE");
    assert.equal(forwarded, 0, "the first read must not silently retry upstream");
    const retry = await read();
    assert.equal(retry.error, null);
    assert.deepEqual(retry.data, []);
    assert.equal(forwarded, 1);
  } finally {
    if (proxy) await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
