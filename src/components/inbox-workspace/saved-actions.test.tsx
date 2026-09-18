import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useInboxSavedActions, type SavedActionSummary } from "./saved-actions";
import { workspaceId, type WorkspaceId } from "./selection";

const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003";
const savedId = "00000000-0000-4000-8000-000000000004";
const target = workspaceId({ orgId, kind: "conversation", conversationId });
const saved: SavedActionSummary = { id: savedId, version: 1, name: "Nurture + owner", createdAt: new Date().toISOString(), definition: { version: 1, steps: [{ type: "outcome", value: "nurture" }, { type: "assign", userId: null }] } };
const replySaved: SavedActionSummary = { id: "00000000-0000-4000-8000-000000000005", version: 2, name: "Reviewed reply", createdAt: new Date().toISOString(), definition: { version: 1, steps: [{ type: "review_reply", text: "Hi there" }] } };
const comboSaved: SavedActionSummary = { id: "00000000-0000-4000-8000-000000000006", version: 1, name: "Outcome then reply", createdAt: new Date().toISOString(), definition: { version: 1, steps: [{ type: "outcome", value: "nurture" }, { type: "review_reply", text: "Hi there" }] } };

function Harness({ values = [saved], selected = [target] as readonly WorkspaceId[] }: { values?: readonly SavedActionSummary[]; selected?: readonly WorkspaceId[] }) {
  const actions = useInboxSavedActions({ enabled: true, identity: { orgId, userId, sessionId: userId, accessEpoch: "1" }, selectedIds: selected, names: new Map([[target, "Ada"]]), onAccessLost: vi.fn(), onCompleted: vi.fn() });
  return <><div>{actions.actions.map(action => <button key={action.id} disabled={!!action.disabledReason || action.pending} onClick={() => actions.prepare(action.id, selected)}>{action.label}</button>)}</div>{actions.picker}{actions.review}{actions.builder}{actions.activity}</>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("loads named actions, preserves the selected target, and routes metadata review/accept", async () => {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
    if (url === "/api/inbox/saved-actions") return Response.json({ items: [saved] });
    if (url.endsWith("/actions/prepare")) return Response.json({ preparationId: "00000000-0000-4000-8000-000000000006", idempotencyKey: (body as { idempotencyKey: string }).idempotencyKey, expiresAt: new Date(Date.now() + 60_000).toISOString(), definition: saved.definition, items: [{ id: "item", target: { kind: "conversation", id: conversationId }, exclusion: null }], eligibleCount: 1, excludedCount: 0, effectCount: 2 });
    if (url.endsWith("/actions/accept")) return Response.json({ operationId: "00000000-0000-4000-8000-000000000007" });
    return Response.json({ operationId: "00000000-0000-4000-8000-000000000007", completed: true, result: "succeeded", items: [], steps: [] });
  }));
  render(<Harness />);
  await screen.findByRole("button", { name: "Nurture + owner" });
  fireEvent.click(screen.getByRole("button", { name: "Nurture + owner" }));
  await screen.findByText("1 eligible · 0 excluded · 2 changes");
  const prepare = calls.find(call => call.url.endsWith("/actions/prepare"));
  expect(prepare?.body).toMatchObject({ targets: [{ kind: "conversation", id: conversationId }], savedAction: { id: saved.id, version: saved.version } });
  fireEvent.click(screen.getByRole("button", { name: "Accept reviewed action" }));
  await screen.findByText("Saved action accepted. Checking durable progress…");
  expect(calls.some(call => call.url.endsWith("/actions/accept"))).toBe(true);
  expect(calls.some(call => call.url.includes("/operations/00000000-0000-4000-8000-000000000007"))).toBe(true);
});

it("routes a reply saved definition through the reviewed reply endpoints and never auto-accepts", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url === "/api/inbox/saved-actions") return Response.json({ items: [replySaved] });
    if (url.endsWith("/actions/prepare")) return Response.json({ kind: "reply", prepared: { preparationId: "00000000-0000-4000-8000-000000000008", idempotencyKey: JSON.parse(String(init?.body)).idempotencyKey, expiresAt: new Date(Date.now() + 60_000).toISOString(), items: [{ id: "item", target: { kind: "conversation", id: conversationId }, exclusion: null, recipient: { contactName: "Ada", propertyAddress: "123 Oak", renderedBody: "Hi there", to: "+15555550100" } }], recipientCount: 1, blockers: [] } });
    if (url.endsWith("/replies/accept")) return Response.json({ operationId: "00000000-0000-4000-8000-000000000009" });
    return Response.json({ operationId: "00000000-0000-4000-8000-000000000009", dispatchComplete: true, receipts: [] });
  }));
  render(<Harness values={[replySaved]} />);
  await screen.findByRole("button", { name: "Reviewed reply" });
  fireEvent.click(screen.getByRole("button", { name: "Reviewed reply" }));
  await screen.findByText("1 recipients · Ready for reviewed send");
  expect(calls.some(url => url.endsWith("/replies/accept"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Accept reviewed action" }));
  await screen.findByText("Saved action accepted. Checking durable progress…");
  expect(calls.some(url => url.endsWith("/replies/accept"))).toBe(true);
  expect(calls.some(url => url.includes("/replies/00000000-0000-4000-8000-000000000009"))).toBe(true);
});

it("retains metadata selection and offers an explicit reply review after terminal metadata results", async () => {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, body });
    if (url === "/api/inbox/saved-actions") return Response.json({ items: [comboSaved] });
    if (url.endsWith("/actions/prepare")) return Response.json({ preparationId: "00000000-0000-4000-8000-000000000007", idempotencyKey: body?.idempotencyKey, expiresAt: new Date(Date.now() + 60_000).toISOString(), definition: comboSaved.definition, items: [{ id: "item", target: { kind: "conversation", id: conversationId }, exclusion: null }], eligibleCount: 1, excludedCount: 0, effectCount: 1, followUp: { kind: "review_reply", template: "Hi there" } });
    if (url.startsWith("/api/inbox/actions/recover")) return Response.json({ state: "pending", operation: null });
    if (url.endsWith("/actions/accept")) return Response.json({ operationId: "00000000-0000-4000-8000-000000000008" });
    if (url.endsWith("/operations/00000000-0000-4000-8000-000000000008")) return Response.json({ operationId: "00000000-0000-4000-8000-000000000008", completed: true, result: "succeeded", items: [], steps: [] });
    if (url.endsWith("/replies/prepare")) return Response.json({ preparationId: "00000000-0000-4000-8000-000000000009", idempotencyKey: body?.idempotencyKey, expiresAt: new Date(Date.now() + 60_000).toISOString(), items: [{ id: "reply-item", target: { kind: "conversation", id: conversationId }, exclusion: null, recipient: { contactName: "Ada", propertyAddress: "123 Oak", renderedBody: "Hi there", to: "+15555550100" } }], recipientCount: 1, blockers: [] });
    return Response.json({});
  }));
  render(<Harness values={[comboSaved]} />);
  await screen.findByRole("button", { name: "Outcome then reply" });
  fireEvent.change(screen.getByRole("combobox", { name: "Saved action" }), { target: { value: `saved:${comboSaved.id}:${comboSaved.version}` } });
  fireEvent.click(screen.getByRole("button", { name: "Review saved action" }));
  await screen.findByText("1 eligible · 0 excluded · 1 changes");
  fireEvent.click(screen.getByRole("button", { name: "Accept reviewed action" }));
  await screen.findByRole("button", { name: "Review reply" });
  fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
  await screen.findByRole("region", { name: "Review saved reply" });
  const replyRequest = calls.find(call => call.url.endsWith("/replies/prepare"));
  expect(replyRequest?.body).toMatchObject({ sourceOperationId: "00000000-0000-4000-8000-000000000008", template: "Hi there" });
  expect(replyRequest?.body).not.toHaveProperty("targets");
  expect(calls.some(call => call.url.endsWith("/replies/accept"))).toBe(false);
});

it("saves and edits definitions through the CRUD route without including client targets", async () => {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/inbox/saved-actions" && !init?.method) return Response.json({ items: [] });
    if (init?.method === "POST") return Response.json(saved);
    return Response.json({ ...saved, version: 2 });
  }));
  render(<Harness values={[]} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create saved action" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Saved action name" }), { target: { value: "My saved action" } });
  fireEvent.click(screen.getByRole("button", { name: "Save action" }));
  await waitFor(() => expect(calls.some(call => call.method === "POST")).toBe(true));
  const post = calls.find(call => call.method === "POST");
  expect(post?.body).toEqual(expect.objectContaining({ name: "My saved action", definition: expect.any(Object) }));
  expect(post?.body).not.toHaveProperty("targets");
});

it("aborts a delayed prepare when its review is closed", async () => {
  let resolve: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/inbox/saved-actions") return Promise.resolve(Response.json({ items: [saved] }));
    if (url.endsWith("/actions/prepare")) return new Promise<Response>(done => { resolve = done; });
    return Promise.resolve(Response.json({}));
  }));
  render(<Harness />);
  await screen.findByRole("button", { name: "Nurture + owner" });
  fireEvent.change(screen.getByRole("combobox", { name: "Saved action" }), { target: { value: `saved:${saved.id}:${saved.version}` } });
  fireEvent.click(screen.getByRole("button", { name: "Review saved action" }));
  await screen.findByText("Checking current records…");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  resolve?.(Response.json({ preparationId: "00000000-0000-4000-8000-000000000006", idempotencyKey: "00000000-0000-4000-8000-000000000007", expiresAt: new Date(Date.now() + 60_000).toISOString(), definition: saved.definition, items: [], eligibleCount: 0, excludedCount: 0 }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /Review saved action/ })).toBeNull());
});
