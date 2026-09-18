import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useInboxMetadataActions } from "./use-metadata-actions";
import { createInboxQueryCache } from "@/lib/inbox/workspace-query";
import { workspaceId } from "./selection";
import type { PrepareInboxActionRequest } from "@/lib/inbox/action-api-contract";
const orgId = "00000000-0000-4000-8000-000000000001", id = "00000000-0000-4000-8000-000000000002";
const target = workspaceId({ orgId, kind: "conversation", conversationId: id });
const caches: ReturnType<typeof createInboxQueryCache>[] = [];
function Harness({ enabled = true, selectionCount = 1, onAccessLost = vi.fn() }: {
    enabled?: boolean;
    selectionCount?: number;
    onAccessLost?: () => void;
}) {
    const cache = caches[0] ?? createInboxQueryCache({ orgId, userId: id, sessionId: id, accessEpoch: "1" });
    if (!caches.length)
        caches.push(cache);
    const actions = useInboxMetadataActions({ enabled, selectionCount, identity: { orgId, userId: id, sessionId: id, accessEpoch: "1" }, orgId, names: new Map([[target, "Ada"]]), cache, onAccessLost, onCompleted: vi.fn() });
    return <>{actions.actions.map(action => <button key={action.id} title={action.disabledReason} disabled={!!action.disabledReason || action.pending} onClick={() => actions.prepare(action.id, [target])}>{action.label}</button>)}<button onClick={actions.clear}>Clear private action state</button>{actions.review}{actions.activity}</>;
}
function prepared(body: PrepareInboxActionRequest) { return { preparationId: "00000000-0000-4000-8000-000000000003", idempotencyKey: body.idempotencyKey, inputHash: "hash", expiresAt: new Date(Date.now() + 60000).toISOString(), definition: body.definition, items: [{ id: "item", target: body.targets[0], propertyId: "property", exclusion: null }], eligibleCount: 1, excludedCount: 0, affectedPropertyCount: 1, effectCount: 1, smsSafetySummary: null }; }
const complete = { operationId: "00000000-0000-4000-8000-000000000004", acceptedAt: new Date().toISOString(), completed: true, result: "succeeded", items: [{ id: "item", target: { kind: "conversation", id }, propertyId: "property", exclusion: null, stepIds: ["step"], state: "succeeded", code: null }], steps: [{ id: "step", action: "outcome", state: "succeeded", code: null, receiptVersion: "1", changed: true }] };
afterEach(() => { cleanup(); for (const cache of caches)
    cache.close(); caches.length = 0; vi.unstubAllGlobals(); sessionStorage.clear(); });
it("requires authoritative preparation before accepting and shows durable progress", async () => {
    const calls: {
        url: string;
        body: unknown;
    }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ url, body }); if (url.endsWith("/prepare"))
        return Response.json(prepared(body)); if (url.endsWith("/accept"))
        return Response.json({ operationId: "00000000-0000-4000-8000-000000000004", acceptedAt: complete.acceptedAt }); return Response.json(complete); }));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
    await screen.findByText("Ada: Eligible");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/inbox/actions/prepare");
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 conversations" }));
    await screen.findByText("Action succeeded");
    expect(calls[1].body).toEqual({ preparationId: "00000000-0000-4000-8000-000000000003", idempotencyKey: (calls[0].body as PrepareInboxActionRequest).idempotencyKey });
    expect(calls[2].url).toBe("/api/inbox/operations/00000000-0000-4000-8000-000000000004");
});
it("keeps an uncertain acceptance on its original key and blocks competing actions", async () => {
    const accepted: unknown[] = [];
    let first = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { const body = init?.body ? JSON.parse(String(init.body)) : null; if (url.endsWith("/prepare"))
        return Response.json(prepared(body)); if (url.endsWith("/accept")) {
        accepted.push(body);
        if (first) {
            first = false;
            throw new TypeError("network lost");
        }
        return Response.json({ operationId: "00000000-0000-4000-8000-000000000004", acceptedAt: complete.acceptedAt });
    } return Response.json(complete); }));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply to 1 conversations" }));
    const retry = await screen.findByRole("button", { name: "Retry apply safely" });
    expect(screen.getByRole("button", { name: "Not interested", hidden: true })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Prepare again" })).not.toBeInTheDocument();
    fireEvent.click(retry);
    await screen.findByText("Action succeeded");
    expect(accepted).toHaveLength(2);
    expect(accepted[0]).toEqual(accepted[1]);
});
it("does not offer an action when server preparation changes the selected identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { const value = prepared(JSON.parse(String(init.body))); value.items[0].target = { kind: "conversation", id: "different" }; return Response.json(value); }));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
    await screen.findByText("The action review did not match this selection.");
    expect(screen.queryByRole("button", { name: /Apply to/ })).not.toBeInTheDocument();
});
it("clears an in-flight review and ignores its late response", async () => {
    let resolve!: (value: Response) => void;
    let body!: PrepareInboxActionRequest;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Promise<Response>(r => { resolve = r; }); }));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear private action state", hidden: true }));
    resolve(Response.json(prepared(body)));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
it("keeps disabled deployment flags from exposing or preparing actions", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<Harness enabled={false}/>);
    expect(screen.queryByRole("button", { name: "Follow up" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
});
it("shows exclusions and cannot accept an entirely ineligible selection", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => { const value = prepared(JSON.parse(String(init.body))); return Response.json({ ...value, items: [{ ...value.items[0], propertyId: null, exclusion: "property_unavailable" }], eligibleCount: 0, excludedCount: 1, affectedPropertyCount: 0, effectCount: 0 }); });
    vi.stubGlobal("fetch", fetch);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
    await screen.findByText("Ada: No eligible property is linked");
    expect(screen.getByRole("button", { name: "Apply to 0 conversations" })).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(1);
});
it("requests parent access cleanup on a canonical preparation denial", async () => {
    const onAccessLost = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 403 })));
    render(<Harness onAccessLost={onAccessLost}/>);
    fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
    await waitFor(() => expect(onAccessLost).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: /Apply to/ })).not.toBeInTheDocument();
});
it("reviews canonical assignee choice and both ordered changes before acceptance", async () => {
    let request: PrepareInboxActionRequest | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/assignees")) return Response.json({ members: [{ userId: id, label: "VA Example" }] });
        request = JSON.parse(String(init?.body)); return Response.json({ ...prepared(request!), effectCount: 2 });
    }));
    render(<Harness />); fireEvent.click(screen.getByRole("button", { name: "Outcome + assignment" }));
    const assignee = await screen.findByRole("combobox", { name: "Assign to" });
    fireEvent.change(screen.getByRole("combobox", { name: "Outcome" }), { target: { value: "nurture" } });
    fireEvent.change(assignee, { target: { value: id } }); fireEvent.click(screen.getByRole("button", { name: "Review both changes" }));
    await screen.findByText("Outcome: Follow up; Assign to VA Example");
    expect(request?.definition.steps).toEqual([{ type: "outcome", value: "nurture" }, { type: "assign", userId: id }]);
    expect(screen.getByText(/2 changes/)).toBeInTheDocument();
});
it("discloses authoritative linked-property and sequence impact before applying", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ...prepared(JSON.parse(String(init?.body))), smsSafetySummary: { contacts: 1, linkedProperties: 2, activeEnrollments: 1 } })));
    render(<Harness />); fireEvent.click(screen.getByRole("button", { name: "Bad number" }));
    expect(await screen.findByRole("note")).toHaveTextContent("1 contacts across 2 linked properties and 1 active sequence enrollments");
    expect(screen.getByRole("note")).toHaveTextContent("Linked properties can extend beyond the selected conversations");
});
it("assigns without forcing an outcome and reviews the canonical assignee", async () => {
    let request: PrepareInboxActionRequest | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { if (url.endsWith("/assignees")) return Response.json({ members: [{ userId: id, label: "VA Example" }] }); request = JSON.parse(String(init?.body)); return Response.json(prepared(request!)); }));
    render(<Harness />); fireEvent.click(screen.getByRole("button", { name: /^Assign$/ }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Assign to" }), { target: { value: id } });
    expect(screen.queryByRole("combobox", { name: "Outcome" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review assignment" })); await screen.findByText("Assign to VA Example");
    expect(request?.definition.steps).toEqual([{ type: "assign", userId: id }]);
});
it("offers SMS opt-out separately from permanent DNC with authoritative expanded scope", async () => {
    let request: PrepareInboxActionRequest | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => { request = JSON.parse(String(init?.body)); return Response.json({ ...prepared(request!), smsSafetySummary: { contacts: 1, linkedProperties: 2, activeEnrollments: 1 } }); }));
    render(<Harness />); expect(screen.queryByRole("button", { name: /DNC/ })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "SMS opt-out" }));
    await screen.findByRole("note"); expect(request?.definition.steps).toEqual([{ type: "outcome", value: "opted_out" }]);
    expect(screen.getByRole("note")).toHaveTextContent("2 linked properties");
});

it("disables metadata actions with an explicit reason above the500-target bound", () => {
  render(<Harness selectionCount={501}/>); expect(screen.getByRole("button", {name:"Follow up"})).toBeDisabled(); expect(screen.getByRole("button", {name:"Follow up"})).toHaveAttribute("title", expect.stringContaining("at most 500"));
});
