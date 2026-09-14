import { afterEach, expect, it, vi } from "vitest";
import { createSendilloReplyTransport } from "./reply-provider";
const reply = { from: "+18165550001", to: "+18165550002", body: "Exact approved text" };
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
it("makes one fixed-endpoint request with exact reviewed text and minimal acceptance", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { messageId: "owned-reference", status: "queued", private: "discarded" } }));
  expect(await createSendilloReplyTransport("synthetic-key", fetcher)(reply, signal())).toEqual({ kind: "accepted", provider: "sendillo", externalId: "owned-reference", providerStatus: "queued" });
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toBe("https://www.sendillo.com/api/v1/messages");
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(reply);
  expect(fetcher.mock.calls[0][1]!.redirect).toBe("error");
});
it("does not call the provider for invalid or already cancelled input", async () => {
  const fetcher = vi.fn<typeof fetch>(), send = createSendilloReplyTransport("synthetic-key", fetcher);
  expect((await send({ ...reply, body: "x".repeat(1601) }, signal())).kind).toBe("not_attempted");
  const abort = new AbortController(); abort.abort();
  expect((await send(reply, abort.signal)).kind).toBe("not_attempted"); expect(fetcher).not.toHaveBeenCalled();
});
it.each([400,401,409,429,500,503])("keeps unverified HTTP %s uncertain without retry", async status => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
  expect((await createSendilloReplyTransport("synthetic-key", fetcher)(reply, signal())).kind).toBe("uncertain"); expect(fetcher).toHaveBeenCalledOnce();
});
it("keeps accepted-without-reference, invalid and oversized response bodies uncertain", async () => {
  for (const response of [Response.json({ status: "accepted" }), new Response("bad json"), new Response("x".repeat(16_385))]) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect((await createSendilloReplyTransport("synthetic-key", fetcher)(reply, signal())).kind).toBe("uncertain"); expect(fetcher).toHaveBeenCalledOnce();
  }
});
it("cancellation during response-body consumption is uncertain and cancels the body", async () => {
  let cancel!: () => void;
  const cancelled = new Promise<void>(resolve => { cancel = resolve; });
  const response = new Response(new ReadableStream({ cancel() { cancel(); } }));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response), abort = new AbortController();
  const result = createSendilloReplyTransport("synthetic-key", fetcher)(reply, abort.signal);
  await Promise.resolve(); await Promise.resolve(); abort.abort();
  expect((await result).kind).toBe("uncertain"); await cancelled; expect(fetcher).toHaveBeenCalledOnce();
});
it("transport failure is uncertain and never automatically retried", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(Error("connection lost"));
  expect((await createSendilloReplyTransport("synthetic-key", fetcher)(reply, signal())).kind).toBe("uncertain"); expect(fetcher).toHaveBeenCalledOnce();
});
it.each([{ id: "owned-reference", status: "failed" }, { id: "owned-reference", success: false }, { data: { messageId: "owned-reference", status: "Rejected" } }])("keeps contradictory 2xx responses uncertain with their reconciliation reference", async body => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
  expect(await createSendilloReplyTransport("synthetic-key", fetcher)(reply, signal())).toEqual({ kind: "uncertain", reason: "contradictory_response", reportedExternalId: "owned-reference" });
  expect(fetcher).toHaveBeenCalledOnce();
});
