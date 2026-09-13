import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), prepare: vi.fn(), accept: vi.fn(), status: vi.fn(), assignees: vi.fn(), recover: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("./action-api", async (importOriginal) => ({ ...await importOriginal<typeof import("./action-api")>(), createInboxActionRepository: () => ({ prepare: mocks.prepare, accept: mocks.accept, status: mocks.status, assignees: mocks.assignees, recover: mocks.recover }) }));
import { POST as prepare } from "@/app/api/inbox/actions/prepare/route";
import { POST as accept } from "@/app/api/inbox/actions/accept/route";
import { GET as status } from "@/app/api/inbox/operations/[operationId]/route";
const id = "abcdef00-0000-4000-8000-000000000001";
const request = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/inbox/actions/prepare", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
beforeEach(() => { vi.stubEnv("INBOX_ACTIONS_SERVER_ENABLED", "1"); vi.clearAllMocks(); mocks.createClient.mockResolvedValue({}); mocks.prepare.mockResolvedValue({ prepared: true }); mocks.accept.mockResolvedValue({ operationId: id }); mocks.status.mockResolvedValue({ operationId: id }); });
afterEach(() => vi.unstubAllEnvs());
describe("disabled-by-default action routes", () => {
    it("does not construct a client or read a body when disabled", async () => { vi.stubEnv("INBOX_ACTIONS_SERVER_ENABLED", "0"); expect((await prepare(request("{}"))).status).toBe(404); expect(mocks.createClient).not.toHaveBeenCalled(); });
    it("rejects cross-site and wrong content types before DB access", async () => { for (const headers of ([{ origin: "https://other.invalid" }, { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" }] as Record<string, string>[]))
        expect((await prepare(request("{}", headers))).status).toBe(headers["content-type"] ? 415 : 403); expect(mocks.createClient).not.toHaveBeenCalled(); });
    it("rejects oversized streaming body", async () => { expect((await prepare(request("a".repeat(131073)))).status).toBe(413); expect(mocks.createClient).not.toHaveBeenCalled(); });
    it("forwards exact raw intent to authoritative parser and sets private response", async () => { const raw = ' {"x":1} '; const response = await prepare(request(raw)); expect(response.status).toBe(200); expect(mocks.prepare.mock.calls[0][0]).toBe(raw); expect(response.headers.get("cache-control")).toBe("private, no-store"); });
    it("acceptance forwards only exact references and rejects duplicate keys", async () => { const raw = JSON.stringify({ preparationId: id, idempotencyKey: id }); expect((await accept(request(raw))).status).toBe(200); expect(mocks.accept.mock.calls[0].slice(0, 2)).toEqual([id, id]); expect((await accept(request(`{"preparationId":"${id}","preparationId":"${id}","idempotencyKey":"${id}"}`))).status).toBe(400); expect(mocks.accept).toHaveBeenCalledTimes(1); });
    it("awaits dynamic route params and denies query overrides", async () => { expect((await status(new Request(`http://localhost/api/inbox/operations/${id}`), { params: Promise.resolve({ operationId: id }) })).status).toBe(200); expect(mocks.status.mock.calls[0][0]).toBe(id); expect((await status(new Request(`http://localhost/api/inbox/operations/${id}?org=other`), { params: Promise.resolve({ operationId: id }) })).status).toBe(403); });
});

import { GET as recover } from "@/app/api/inbox/operations/recover/route";
import { GET as assignees } from "@/app/api/inbox/actions/assignees/route";
it("recovery admits one exact key query and assignees admit no overrides", async () => {
 mocks.recover.mockResolvedValue(null); mocks.assignees.mockResolvedValue([]);
 expect((await recover(new Request(`http://localhost/api/inbox/operations/recover?preparationId=${id}&idempotencyKey=${id}`))).status).toBe(200);
 expect(mocks.recover.mock.calls[0][0]).toBe(id);
 expect((await recover(new Request(`http://localhost/api/inbox/operations/recover?preparationId=${id}&idempotencyKey=${id}&idempotencyKey=${id}`))).status).toBe(403);
 expect((await assignees(new Request("http://localhost/api/inbox/actions/assignees"))).status).toBe(200);
 expect((await assignees(new Request("http://localhost/api/inbox/actions/assignees?org=other"))).status).toBe(403);
});
