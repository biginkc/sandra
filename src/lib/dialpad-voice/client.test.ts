import { afterEach, describe, expect, it, vi } from "vitest";
import { DialpadVoiceClient, DialpadVoiceError } from "./client";

const userId = "1234567890123456";
const input = { userId, deviceId: "browser-device", phoneNumber: "+15555550101", outboundCallerId: "+12025550101", customData: "opaque-intent" };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
afterEach(() => vi.useRealTimers());

function setup(response: () => Promise<Response> = async () => json({})) {
  const fetcher = vi.fn<typeof fetch>(response);
  return { fetcher, client: new DialpadVoiceClient("private-key", { fetch: fetcher, timeoutMs: 50 }) };
}

describe("DialpadVoiceClient", () => {
  it("always scopes call pages to the supplied user and encodes opaque cursors", async () => {
    const { client, fetcher } = setup(async () => json({ items: [], cursor: "next" }));
    await expect(client.listCalls(userId, { cursor: "a&target_id=other", startedAfter: 1, startedBefore: 10 })).resolves.toEqual({ items: [], cursor: "next" });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v2/call");
    expect(Object.fromEntries(url.searchParams)).toEqual({ target_type: "user", target_id: userId, cursor: "a&target_id=other", started_after: "1", started_before: "10" });
  });

  it("uses documented device, caller ID and detail paths without permitting path injection", async () => {
    const { client, fetcher } = setup();
    await client.listUserDevices(userId, "next");
    await client.getCallerId(userId);
    await client.getCall("123");
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/v2/userdevices", `/api/v2/users/${userId}/caller_id`, "/api/v2/call/123"]);
    expect(() => client.getCall("123/../../users")).toThrow(DialpadVoiceError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("selects one device and preserves custom data without consult mode or automatic retries", async () => {
    const { client, fetcher } = setup();
    await client.initiateSelectedDeviceCall(input);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://dialpad.com/api/v2/call");
    expect(options).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(JSON.parse(options!.body as string)).toEqual({ user_id: Number(userId), device_id: input.deviceId, phone_number: input.phoneNumber, outbound_caller_id: input.outboundCallerId, custom_data: input.customData, is_consult: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client)).not.toContain("private-key");
  });

  it("hangs up precisely the supplied call and accepts an empty successful response", async () => {
    const { client, fetcher } = setup(async () => new Response(null, { status: 204 }));
    await expect(client.hangupCall("123")).resolves.toEqual({});
    expect(String(fetcher.mock.calls[0][0])).toBe("https://dialpad.com/api/v2/call/123/actions/hangup");
    expect(fetcher.mock.calls[0][1]?.method).toBe("PUT");
  });

  it.each(["office", "department", "callcenter"] as const)("preserves the authorized %s identity without changing the calling user", async type => {
    const { client, fetcher } = setup();
    await client.initiateSelectedDeviceCall({ ...input, group: { id: "42", type } });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ user_id: Number(userId), group_id: 42, group_type: type, outbound_caller_id: input.outboundCallerId });
  });

  it("rejects malformed shared-group identity before any provider request", () => {
    const { client, fetcher } = setup();
    for (const group of [{ id: "9007199254740993", type: "office" }, { id: "42", type: "OfficeGroup" }, { id: "", type: "department" }]) {
      expect(() => client.initiateSelectedDeviceCall({ ...input, group: group as { id: string; type: "office" } })).toThrow(DialpadVoiceError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads the mapped provider user without accepting path injection", async () => {
    const { client, fetcher } = setup();
    await client.getUser(userId);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(`/api/v2/users/${userId}`);
    expect(() => client.getUser("123/other")).toThrow(DialpadVoiceError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads complete callable personas for the selected user without caller-ID filtering", async () => {
    const payload = { items: [{ id: userId, type: "user", phone_numbers: [input.outboundCallerId] }, { id: "42", type: "office", phone_numbers: ["+12025550102"] }] };
    const { client, fetcher } = setup(async () => json(payload));
    await expect(client.listUserPersonas(userId)).resolves.toEqual(payload);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(`/api/v2/users/${userId}/personas`);
    expect(() => client.listUserPersonas("123/../456")).toThrow(DialpadVoiceError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe numeric identifiers, missing device/correlation and invalid caller numbers before dispatch", () => {
    const { client, fetcher } = setup();
    for (const patch of [{ userId: "9007199254740993" }, { deviceId: "" }, { customData: "" }, { outboundCallerId: "blocked" }]) {
      expect(() => client.initiateSelectedDeviceCall({ ...input, ...patch })).toThrow(DialpadVoiceError);
    }
    expect(() => client.listCalls(userId, { startedAfter: 10, startedBefore: 1 })).toThrow(DialpadVoiceError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects login HTML and malformed JSON instead of treating HTTP 200 as data", async () => {
    for (const response of [new Response("<html>login private-key</html>"), new Response("{", { headers: { "content-type": "application/json" } }), json([])]) {
      const { client } = setup(async () => response);
      await expect(client.getCall("123")).rejects.toMatchObject({ code: "response" });
    }
  });

  it("redacts upstream and transport errors and never retries uncertain call initiation", async () => {
    for (const response of [async () => new Response("private-key https://sensitive", { status: 429 }), async (): Promise<Response> => { throw new Error("private-key https://sensitive"); }]) {
      const { client, fetcher } = setup(response);
      try { await client.initiateSelectedDeviceCall(input); expect.fail("expected error"); } catch (error) {
        expect(error).toBeInstanceOf(DialpadVoiceError);
        expect(String(error)).not.toMatch(/private-key|sensitive/);
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => ({
      ok: true, headers: new Headers({ "content-type": "application/json" }),
      text: () => new Promise<string>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("private-key")))),
    }) as Response);
    const client = new DialpadVoiceClient("private-key", { fetch: fetcher, timeoutMs: 50 });
    const assertion = expect(client.getCall("123")).rejects.toMatchObject({ code: "transport" });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
