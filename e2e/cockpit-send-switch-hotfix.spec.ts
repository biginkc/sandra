import { expect, test } from "@playwright/test";

import {
  adminClient,
  E2E_MOCK_BUSINESS_NUMBER,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
} from "./fixtures";
import { checkQuietHours, STATE_TO_TZ } from "../src/lib/messaging/quiet-hours";
import { ensureConversationIdForThread } from "../src/lib/messages/threading";

type Admin = ReturnType<typeof adminClient>;
type SendSwitchProbe = {
  originalFetch: typeof window.fetch;
  bDetailGets: number;
  messagesRscGets: number;
};
type ProbeWindow = typeof window & { __sendSwitchProbe?: SendSwitchProbe };

function callableStateForNow(): string | null {
  for (const state of Object.keys(STATE_TO_TZ).sort()) {
    if (checkQuietHours(state).ok) return state;
  }
  return null;
}

async function seedThread(
  admin: Admin,
  options: {
    phone: string;
    tag: string;
    initialBody: string;
    state: string;
    history?: number;
  },
) {
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({
      first_name: "Switch",
      last_name: options.tag,
      phone_1: options.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact) throw contactError ?? new Error("contact seed failed");

  const [property] = await seedProspects(admin, 1, options.tag);
  const { error: propertyError } = await admin
    .from("properties")
    .update({
      homeowner_contact_id: contact.id,
      status: "new_lead",
      state: options.state,
    })
    .eq("id", property.id);
  if (propertyError) throw propertyError;
  const { error: consentError } = await admin.from("consent_events").insert({
    contact_id: contact.id,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "e2e-send-switch-hotfix",
  });
  if (consentError) throw consentError;
  const threadId = await ensureConversationIdForThread(admin, contact.id, property.id);
  const messages = Array.from({ length: (options.history ?? 0) + 1 }, (_, index) => ({
    channel: "sms" as const,
    direction: "inbound" as const,
    status: "received",
    conversation_id: threadId,
    contact_id: contact.id,
    property_id: property.id,
    from_address: options.phone,
    to_address: E2E_MOCK_BUSINESS_NUMBER,
    body: index === 0 ? options.initialBody : `synthetic ${options.tag} history ${index}`,
    created_at: new Date(Date.now() - ((options.history ?? 0) - index) * 60_000).toISOString(),
  }));
  const { error: messageError } = await admin.from("messages").insert(messages);
  if (messageError) throw messageError;
  return { propertyId: property.id, threadId };
}

test.describe("send then switch conversation", () => {
  test("preserves B when A's send completion arrives before or after the switch", async ({ page }) => {
    const admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);
    const callableState = callableStateForNow();
    if (callableState === null) {
      test.skip(true, "outside legal send windows in every configured US state");
      return;
    }

    for (const order of ["send-first", "switch-first"] as const) {
      const token = `${order}-${Date.now()}`;
      const aPhone = order === "send-first" ? "+18165557901" : "+18165557903";
      const a = await seedThread(admin, {
        phone: aPhone,
        tag: `SWITCH-A-${token}`,
        initialBody: `synthetic A ${token}`,
        state: callableState,
      });
      const b = await seedThread(admin, {
        phone: order === "send-first" ? "+18165557902" : "+18165557904",
        tag: `SWITCH-B-${token}`,
        initialBody: `synthetic B ${token}`,
        history: 42,
        state: callableState,
      });
      const reply = `synthetic A reply ${token}`;
      const draft = `synthetic B draft ${token}`;
      let allowActionResponse: () => void = () => {};
      let actionReached!: () => void;
      const actionReachedPromise = new Promise<void>((resolve) => {
        actionReached = resolve;
      });
      const actionResponseAllowed = new Promise<void>((resolve) => {
        allowActionResponse = resolve;
      });
      let heldActionCount = 0;
      let interceptionArmed = false;
      let claimedSend = false;
      let actionResponseReleased = false;
      let bDetailRequestsAfterRelease = 0;
      let documentNavigations = 0;
      const onNavigation = () => { documentNavigations += 1; };

      await page.route("**/*", async (route) => {
        const request = route.request();
        const requestUrl = new URL(request.url());
        if (
          actionResponseReleased &&
          request.method() === "GET" &&
          requestUrl.pathname === "/api/messages/thread-detail" &&
          requestUrl.searchParams.get("thread") === b.threadId
        ) {
          bDetailRequestsAfterRelease += 1;
        }
        if (
          !interceptionArmed ||
          claimedSend ||
          request.method() !== "POST" ||
          !request.headers()["next-action"] ||
          !request.postData()?.includes(a.propertyId)
        ) {
          await route.continue();
          return;
        }
        // Claim before awaiting the upstream response. This is the only
        // request we are allowed to delay: A's just-submitted reply.
        claimedSend = true;
        heldActionCount += 1;
        const response = await route.fetch();
        actionReached();
        await actionResponseAllowed;
        await route.fulfill({ response });
      });
      page.on("framenavigated", onNavigation);

      try {
        await page.goto(`/messages?thread=${encodeURIComponent(a.threadId)}`);
        documentNavigations = 0;
        await expect(page.getByTestId("inbox-detail-panel")).toContainText(`synthetic A ${token}`);
        const shell = `e2e-shell-${token}`;
        await page.getByTestId("inbox-cockpit-grid").evaluate((element, marker) => {
          element.setAttribute("data-e2e-shell", marker);
        }, shell);
        await page.getByLabel("Reply to this lead").fill(reply);
        interceptionArmed = true;
        const aSendResponse = page.waitForResponse((response) => {
          const request = response.request();
          return (
            response.status() === 200 &&
            request.method() === "POST" &&
            Boolean(request.headers()["next-action"]) &&
            Boolean(request.postData()?.includes(a.propertyId))
          );
        });
        await page.getByTestId("inline-reply-send").click();
        await actionReachedPromise;

        if (order === "send-first") {
          allowActionResponse();
          await (await aSendResponse).finished();
          await expect(page.getByText(`Sent to ${aPhone}.`, { exact: true })).toBeVisible();
          await expect(page.getByTestId("inbox-detail-panel")).toContainText(reply);
        }

        await page.getByTestId(`inbox-thread-${b.threadId}`).click();
        await expect(page.getByTestId("inbox-detail-panel")).toContainText(`synthetic B ${token}`);
        const bScroller = page.getByTestId("inbox-detail-scroll");
        await expect.poll(() => bScroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        await bScroller.evaluate((element) => { element.scrollTop = 64; });
        const scrollBefore = await bScroller.evaluate((element) => element.scrollTop);
        await page.getByLabel("Reply to this lead").fill(draft);

        await page.evaluate((threadId) => {
          const scope = window as ProbeWindow;
          const originalFetch = window.fetch.bind(window);
          scope.__sendSwitchProbe = {
            originalFetch,
            bDetailGets: 0,
            messagesRscGets: 0,
          };
          window.fetch = async (input, init) => {
            const request = input instanceof Request ? input : null;
            const url = new URL(request?.url ?? String(input), window.location.href);
            const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
            const headers = new Headers(request?.headers);
            if (init?.headers) {
              new Headers(init.headers).forEach((value, key) => headers.set(key, value));
            }
            if (
              method === "GET" &&
              url.pathname === "/api/messages/thread-detail" &&
              url.searchParams.get("thread") === threadId
            ) {
              scope.__sendSwitchProbe!.bDetailGets += 1;
            }
            if (
              method === "GET" &&
              url.pathname === "/messages" &&
              (url.searchParams.has("_rsc") ||
                headers.has("rsc") ||
                headers.get("accept")?.includes("text/x-component"))
            ) {
              scope.__sendSwitchProbe!.messagesRscGets += 1;
            }
            return originalFetch(input, init);
          };
        }, b.threadId);

        if (order === "switch-first") {
          // The A composer captured A's revalidation callback. Once B is
          // active that callback must return before fetching. The exact A
          // response plus its visible toast prove the browser consumed the
          // late result before this no-B-fetch assertion.
          actionResponseReleased = true;
          allowActionResponse();
          await (await aSendResponse).finished();
          await expect(page.getByText(`Sent to ${aPhone}.`, { exact: true })).toBeVisible();
          await page.evaluate(
            () => new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
          );
          expect(bDetailRequestsAfterRelease).toBe(0);
          await expect.poll(() => page.evaluate(() => {
            const scope = window as ProbeWindow;
            return scope.__sendSwitchProbe && {
              bDetailGets: scope.__sendSwitchProbe.bDetailGets,
              messagesRscGets: scope.__sendSwitchProbe.messagesRscGets,
            };
          })).toEqual({ bDetailGets: 0, messagesRscGets: 0 });
        }
        await expect(page.getByLabel("Reply to this lead")).toHaveValue(draft);
        await expect(page.getByTestId("inbox-detail-panel")).not.toContainText(reply);
        await expect(page).toHaveURL(new RegExp(`[?&]thread=${b.threadId}`));
        expect(heldActionCount).toBe(1);
        expect(documentNavigations).toBe(0);
        expect(await page.getByTestId("inbox-cockpit-grid").getAttribute("data-e2e-shell")).toBe(shell);
        expect(await bScroller.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
      } finally {
        allowActionResponse();
        await page.evaluate(() => {
          const scope = window as ProbeWindow;
          if (!scope.__sendSwitchProbe) return;
          window.fetch = scope.__sendSwitchProbe.originalFetch;
          delete scope.__sendSwitchProbe;
        }).catch(() => {});
        page.off("framenavigated", onNavigation);
        await page.unroute("**/*");
      }
    }
  });
});
