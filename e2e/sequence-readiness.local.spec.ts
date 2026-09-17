import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  adminClient,
  DEFAULT_ORG_ID,
  ensureTestUser,
  resetTenantTables,
  seedProspects,
  TEST_USER_EMAIL,
  TEST_USER_PASSWORD,
} from "./fixtures";
import {
  ensureE2ERunEnvironment,
  identityForPrincipal,
} from "../src/lib/supabase/e2e-identity-guard";

const LEDGER_URL =
  process.env.SEQUENCE_READINESS_LEDGER_URL ??
  "http://127.0.0.1:3558/ledger";
const LEDGER_TOKEN = process.env.SEQUENCE_READINESS_LEDGER_TOKEN ?? "";
const ASSIGNEE = identityForPrincipal(
  ensureE2ERunEnvironment(),
  "assignee",
);

async function signIn(
  page: Page,
  identity: { email: string; password: string } = {
    email: TEST_USER_EMAIL,
    password: TEST_USER_PASSWORD,
  },
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(identity.email);
  await page.getByLabel("Password").fill(identity.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/(dashboard|leads|sequences)/, { timeout: 15_000 });
}

async function seedLead(
  admin: ReturnType<typeof adminClient>,
  suffix: string,
): Promise<{ propertyId: string; contactId: string }> {
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .insert({
      org_id: DEFAULT_ORG_ID,
      first_name: "Sequence",
      last_name: `Browser ${suffix}`,
      phone_1: "+18165559421",
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact) throw contactError ?? new Error("contact seed failed");

  const { error: consentError } = await admin.from("consent_events").insert({
    org_id: DEFAULT_ORG_ID,
    contact_id: contact.id,
    channel: "sms",
    event_type: "opt_in_marketing_written",
    source: "sequence-readiness-browser",
  });
  if (consentError) throw consentError;

  const [property] = await seedProspects(admin, 1, `Sequence ${suffix}`);
  const { error: propertyError } = await admin
    .from("properties")
    .update({ homeowner_contact_id: contact.id, status: "new_lead" })
    .eq("id", property.id);
  if (propertyError) throw propertyError;
  return { propertyId: property.id, contactId: contact.id };
}

async function createSequence(page: Page, name: string): Promise<string> {
  await page.goto("/sequences/new");
  const nameInput = page.getByLabel("Name");
  const descriptionInput = page.getByLabel("Description");
  const createButton = page.getByRole("button", { name: /^create$/i });
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toBeEditable();
  await nameInput.fill(name);
  await descriptionInput.fill("Local browser persistence contract");
  // In Next dev, hydration can replace a controlled input after the first
  // sibling interaction. Re-apply the value and assert that React retained it
  // before submitting, rather than retrying the server action or sleeping.
  await nameInput.fill(name);
  await expect(nameInput).toHaveValue(name);
  await expect(descriptionInput).toHaveValue("Local browser persistence contract");
  await expect(createButton).toBeEnabled();
  await createButton.click();
  await page.waitForURL(/\/sequences\/[0-9a-f-]+\/edit$/, { timeout: 15_000 });
  return new URL(page.url()).pathname.split("/")[2]!;
}

async function addStatusStep(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^add step$/i }).click();
  const dialog = page.getByRole("dialog");
  const selects = dialog.getByRole("combobox");
  await selects.nth(1).selectOption("change_status");
  await selects.nth(2).selectOption("contacted");
  await dialog.getByRole("button", { name: /^add step$/i }).click();
  await expect(page.getByRole("heading", { name: "Step 1" })).toBeVisible();
}

async function addSmsStep(page: Page, body: string): Promise<void> {
  await page.getByRole("button", { name: /^add step$/i }).click();
  const dialog = page.getByRole("dialog");
  const selects = dialog.getByRole("combobox");
  await selects.nth(1).selectOption("send_sms");
  await dialog.getByLabel("Message body").fill(body);
  await dialog.getByRole("button", { name: /^add step$/i }).click();
  await expect(page.getByRole("heading", { name: "Step 1" })).toBeVisible();
}

async function enrollmentStatus(
  admin: ReturnType<typeof adminClient>,
  sequenceId: string,
  propertyId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("sequence_enrollments")
    .select("status")
    .eq("sequence_id", sequenceId)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (error) throw error;
  return data?.status ?? null;
}

async function ledgerEvents(request: APIRequestContext): Promise<Array<Record<string, unknown>>> {
  const response = await request.get(LEDGER_URL, {
    headers: { authorization: `Bearer ${LEDGER_TOKEN}` },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { events?: Array<Record<string, unknown>> };
  return body.events ?? [];
}

function isLoopbackHttpUrl(value: string): boolean {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  );
}

async function installBrowserEgressGuard(
  page: Page,
  request: APIRequestContext,
): Promise<void> {
  await page.context().route("**/*", async (route) => {
    const target = route.request().url();
    const parsed = new URL(target);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !isLoopbackHttpUrl(target)
    ) {
      // Abort first: recording is a separate loopback request and must never
      // delay the browser-side network denial.
      await route.abort("blockedbyclient");
      await request.post(`${LEDGER_URL}/events`, {
        headers: { authorization: `Bearer ${LEDGER_TOKEN}` },
        data: {
          kind: "browser-external-http-denied",
          process: "browser-context",
          method: route.request().method(),
          origin: parsed.origin,
          pathname: parsed.pathname,
          beforeNetwork: true,
        },
      });
      return;
    }
    await route.continue();
  });
}

test.describe("sequence readiness — local browser contract", () => {
  test.beforeEach(async ({ page, request }) => {
    await installBrowserEgressGuard(page, request);
    const admin = adminClient();
    await resetTenantTables(admin);
    await ensureTestUser(admin);
  });

  test("create/edit/enroll then persist pause, resume, cancel, and reload", async ({
    page,
  }) => {
    const admin = adminClient();
    await signIn(page);

    const sequenceName = `Browser readiness ${Date.now()}`;
    const sequenceId = await createSequence(page, sequenceName);
    await addStatusStep(page);

    await page.getByLabel("Description").fill("Edited local description");
    await page.getByRole("button", { name: /^save$/i }).first().click();
    await expect(page.getByLabel("Description")).toHaveValue(
      "Edited local description",
    );
    await expect
      .poll(async () => {
        const { data, error } = await admin
          .from("sequences")
          .select("description")
          .eq("id", sequenceId)
          .maybeSingle();
        if (error) throw error;
        return data?.description ?? null;
      })
      .toBe("Edited local description");
    await page.reload();
    await expect(page.getByLabel("Description")).toHaveValue(
      "Edited local description",
    );

    const { propertyId } = await seedLead(admin, "enroll");
    await page.goto(`/leads/${propertyId}`);
    await page.getByTestId("enroll-in-sequence-button").click();
    const option = page.getByRole("button", {
      name: new RegExp(`^${sequenceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    });
    await expect(option).toBeVisible();
    await option.click();
    await expect
      .poll(() => enrollmentStatus(admin, sequenceId, propertyId), {
        timeout: 10_000,
      })
      .toBe("active");

    // Mutate persisted state out-of-band to exercise the same reload path the
    // cron/reply handlers use, then perform the user-visible resume action.
    const { error: pauseError } = await admin
      .from("sequence_enrollments")
      .update({ status: "paused", pause_reason: "manual", next_run_at: null })
      .eq("sequence_id", sequenceId)
      .eq("property_id", propertyId);
    if (pauseError) throw pauseError;
    await page.reload();
    await expect(page.getByText(/paused \(manual\)/i)).toBeVisible();
    await page.getByRole("button", { name: /^resume$/i }).click();
    await expect
      .poll(() => enrollmentStatus(admin, sequenceId, propertyId), {
        timeout: 10_000,
      })
      .toBe("active");

    await page.reload();
    await expect(page.getByText(sequenceName, { exact: false })).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect
      .poll(() => enrollmentStatus(admin, sequenceId, propertyId), {
        timeout: 10_000,
      })
      .toBe("completed");

    const { data: persisted, error: persistedError } = await admin
      .from("sequence_enrollments")
      .select("status, pause_reason, current_step_index")
      .eq("sequence_id", sequenceId)
      .eq("property_id", propertyId)
      .single();
    if (persistedError || !persisted) throw persistedError ?? new Error("missing enrollment");
    expect(persisted.status).toBe("completed");
    expect(persisted.pause_reason).toBeNull();
    expect(persisted.current_step_index).toBe(0);
  });

  test("mock SMS send, inbound reply, thread, and provider ledger stay local", async ({
    page,
    request,
    baseURL,
  }) => {
    const admin = adminClient();
    await signIn(page);

    const sequenceName = `Browser SMS ${Date.now()}`;
    const sequenceId = await createSequence(page, sequenceName);
    const body = "Hello from the local sequence readiness lane";
    await addSmsStep(page, body);
    await addStatusStep(page);
    const { propertyId } = await seedLead(admin, "sms");

    await page.goto(`/leads/${propertyId}`);
    await page.getByTestId("enroll-in-sequence-button").click();
    await page
      .getByRole("button", {
        name: new RegExp(`^${sequenceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      })
      .click();
    await expect
      .poll(() => enrollmentStatus(admin, sequenceId, propertyId), {
        timeout: 10_000,
      })
      .toBe("active");

    const cronResponse = await request.post(
      `${baseURL}/api/cron/sequence-tick`,
      { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
    );
    expect(cronResponse.status()).toBe(200);

    await expect
      .poll(
        async () =>
          (await ledgerEvents(request)).filter(
            (event) => event.kind === "mock-provider-send",
          ),
        { timeout: 10_000 },
      )
      .toHaveLength(1);
    const sendEvents = await ledgerEvents(request);
    const sendEvent = sendEvents.find(
      (event) => event.kind === "mock-provider-send",
    );
    expect(sendEvent?.provider).toBe("mock");
    expect(sendEvent?.to).toBe("+18165559421");

    await expect
      .poll(async () => {
        const { data, error } = await admin
          .from("messages")
          .select("id, status, external_id, body")
          .eq("property_id", propertyId)
          .eq("direction", "outbound")
          .maybeSingle();
        if (error) throw error;
        return data ?? null;
      })
      .toMatchObject({ status: "sent" });
    const { data: outbound, error: outboundError } = await admin
      .from("messages")
      .select("id, status, external_id, body")
      .eq("property_id", propertyId)
      .eq("direction", "outbound")
      .maybeSingle();
    if (outboundError || !outbound) {
      throw outboundError ?? new Error("missing outbound message");
    }
    expect(outbound.body).toContain(body);

    const replyBody = "Interested — please send details";
    const replyResponse = await request.post(
      `${baseURL}/api/webhooks/dialpad/sms`,
      {
        headers: {
          "x-mock-signature": "valid",
          "content-type": "application/json",
        },
        data: {
          externalId: `browser_reply_${Date.now()}`,
          from: "+18165559421",
          to: "+15551234567",
          body: replyBody,
        },
      },
    );
    expect(replyResponse.status()).toBe(200);

    await expect
      .poll(() => enrollmentStatus(admin, sequenceId, propertyId), {
        timeout: 10_000,
      })
      .toBe("paused");
    const { data: paused, error: pausedError } = await admin
      .from("sequence_enrollments")
      .select("pause_reason")
      .eq("sequence_id", sequenceId)
      .eq("property_id", propertyId)
      .single();
    if (pausedError || !paused) throw pausedError ?? new Error("missing paused enrollment");
    expect(paused.pause_reason).toBe("inbound_reply");

    await page.goto(`/leads/${propertyId}`);
    await expect(page.getByText(replyBody)).toBeVisible();
    await expect(page.getByText(/paused \(inbound_reply\)/i)).toBeVisible();
    expect(outbound.external_id).toBe(sendEvent?.externalId);
  });

  test("non-admin cannot enter sequence authoring", async ({ page }) => {
    const admin = adminClient();
    await ensureTestUser(admin, { principal: "assignee", membershipRole: "member" });
    await signIn(page, ASSIGNEE);
    await page.goto("/sequences/new");
    await expect(page).toHaveURL(/\/leads$/);
    await expect(page.getByRole("heading", { name: /new sequence/i })).toHaveCount(0);
  });

  test("a user without a second-org membership cannot see that org's sequence", async ({
    page,
  }) => {
    const admin = adminClient();
    const secondOrgId = randomUUID();
    const secondOrgName = `Browser isolation org ${Date.now()}`;
    const secondSequenceName = `Hidden other-org sequence ${Date.now()}`;
    const { error: orgError } = await admin
      .from("organizations")
      .insert({ id: secondOrgId, name: secondOrgName });
    if (orgError) throw orgError;
    const { data: sequence, error: sequenceError } = await admin
      .from("sequences")
      .insert({ org_id: secondOrgId, name: secondSequenceName })
      .select("id")
      .single();
    if (sequenceError || !sequence) throw sequenceError ?? new Error("second-org seed failed");

    try {
      await signIn(page);
      await page.goto("/sequences");
      await expect(page.getByText(secondSequenceName, { exact: true })).toHaveCount(0);
    } finally {
      await admin.from("organizations").delete().eq("id", secondOrgId);
    }
  });

  test("browser context denies external HTTP before network", async ({
    page,
    request,
  }) => {
    await page
      .goto("https://example.com/sequence-readiness-browser-probe")
      .catch(() => undefined);
    await expect
      .poll(async () =>
        (await ledgerEvents(request)).some(
          (event) =>
            event.kind === "browser-external-http-denied" &&
            event.process === "browser-context" &&
            event.origin === "https://example.com" &&
            event.beforeNetwork === true,
        ),
      )
      .toBe(true);
  });
});

test("server-side egress guard records denial before network in local ledger", async ({
  request,
}) => {
  await expect
    .poll(
      async () => {
        const events = await ledgerEvents(request);
        return events.some(
          (event) =>
            event.kind === "external-http-denied" &&
            event.process === "sequence-readiness-probe" &&
            event.origin === "https://example.com" &&
            event.beforeNetwork === true,
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  const appEvents = await ledgerEvents(request);
  expect(
    appEvents.some(
      (event) =>
        event.kind === "guard-ready" && event.process === "sequence-readiness-app",
    ),
  ).toBe(true);
  expect(process.env.MESSAGING_PROVIDER).toBe("mock");

  const unauthenticated = await request.get(LEDGER_URL);
  expect(unauthenticated.status()).toBe(404);
});
