import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";

const testClient = createTestClient();

// Mock both server-client modules so the action's `createClient()` and
// `createAdminClient()` calls hit the test project. Same pattern as
// other admin-action integration suites (see
// src/app/(dashboard)/leads/bulk-actions.integration.test.ts).
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => testClient,
}));

// Pin admin-email check before the action module loads so isAdminEmail()
// reads a known value. Per-test we flip currentEmail between admin and
// non-admin to exercise the FORBIDDEN path.
process.env.ADMIN_EMAILS = "jarrad@bmhgroupkc.com";

let currentEmail: string | null = "jarrad@bmhgroupkc.com";
vi.spyOn(testClient.auth, "getUser").mockImplementation(async () =>
  ({
    data: {
      user: currentEmail
        ? ({ id: null, email: currentEmail } as never)
        : null,
    },
    error: null,
  }) as never,
);

import {
  createWebhookConsumer,
  rotateWebhookConsumer,
  toggleWebhookConsumer,
  updateWebhookConsumerNotes,
} from "./actions";

function hashSecret(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

async function clearConsumers(): Promise<void> {
  // sandra-crm-test's `reset_tenant_tables()` doesn't include
  // webhook_consumers (admin-config table, not tenant data). Wipe it
  // by hand. Using a never-matching id sentinel keeps `delete()` from
  // turning into a wide-open whoops in case a typo ever escapes.
  await testClient
    .from("webhook_consumers")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
}

describe("admin/webhooks actions (integration)", () => {
  beforeEach(async () => {
    await clearConsumers();
    currentEmail = "jarrad@bmhgroupkc.com";
  });

  describe("createWebhookConsumer", () => {
    it("type=lead with valid source creates a row, returns plaintext + URL, and stores the SHA-256 hash", async () => {
      const result = await createWebhookConsumer({
        name: "Enzo Dialer",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);

      // Plaintext secret is 24 raw bytes → 48 hex chars.
      expect(result.data.plaintextSecret).toMatch(/^[0-9a-f]{48}$/);
      // URL hardcoded to prod alias unless NEXT_PUBLIC_SITE_URL overrides
      // (which the test env doesn't set).
      expect(result.data.url).toBe(
        `https://sandra-sooty.vercel.app/api/webhooks/leads/${result.data.plaintextSecret}`,
      );

      const { data: row } = await testClient
        .from("webhook_consumers")
        .select(
          "name, consumer_type, default_source, secret_hash, enabled, revoked_at",
        )
        .eq("id", result.data.id)
        .single();
      expect(row).toBeTruthy();
      expect(row!.name).toBe("Enzo Dialer");
      expect(row!.consumer_type).toBe("lead");
      expect(row!.default_source).toBe("cold_call");
      expect(row!.enabled).toBe(true);
      expect(row!.revoked_at).toBeNull();
      // Re-hashing the returned plaintext must match the stored hash —
      // i.e., the plaintext we returned is genuinely the secret.
      expect(row!.secret_hash).toBe(hashSecret(result.data.plaintextSecret));
    });

    it("type=lead without default_source → VALIDATION error", async () => {
      const result = await createWebhookConsumer({
        name: "Lead Without Source",
        consumer_type: "lead",
        default_source: null,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message.toLowerCase()).toContain("default source");
    });

    it("type=provider with default_source → VALIDATION error", async () => {
      const result = await createWebhookConsumer({
        name: "Provider With Source",
        consumer_type: "provider",
        default_source: "cold_call",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("VALIDATION");
    });

    it("type=provider without source → succeeds; URL points to /skip-trace/", async () => {
      const result = await createWebhookConsumer({
        name: "Tracerfy Skip-Trace",
        consumer_type: "provider",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.data.url).toBe(
        `https://sandra-sooty.vercel.app/api/webhooks/skip-trace/${result.data.plaintextSecret}`,
      );

      const { data: row } = await testClient
        .from("webhook_consumers")
        .select("consumer_type, default_source")
        .eq("id", result.data.id)
        .single();
      expect(row!.consumer_type).toBe("provider");
      expect(row!.default_source).toBeNull();
    });

    it("duplicate name → VALIDATION error", async () => {
      const first = await createWebhookConsumer({
        name: "Enzo Dialer",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      expect(first.ok).toBe(true);

      const second = await createWebhookConsumer({
        name: "Enzo Dialer",
        consumer_type: "lead",
        default_source: "web_form",
      });
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected duplicate to fail");
      expect(second.error.code).toBe("VALIDATION");
      expect(second.error.message).toMatch(/already exists/i);
    });

    it("non-admin caller → FORBIDDEN", async () => {
      currentEmail = "not-an-admin@example.com";
      const result = await createWebhookConsumer({
        name: "Sneaky",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected forbidden");
      expect(result.error.code).toBe("FORBIDDEN");

      // Confirm nothing was written.
      const { data } = await testClient
        .from("webhook_consumers")
        .select("id")
        .eq("name", "Sneaky");
      expect(data ?? []).toEqual([]);
    });

    it("name-only whitespace → VALIDATION error", async () => {
      const result = await createWebhookConsumer({
        name: "   ",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected validation");
      expect(result.error.code).toBe("VALIDATION");
    });
  });

  describe("rotateWebhookConsumer", () => {
    it("replaces secret_hash; old plaintext no longer hashes to the stored value", async () => {
      const created = await createWebhookConsumer({
        name: "Rotatable",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      if (!created.ok) throw new Error(created.error.message);
      const oldHash = hashSecret(created.data.plaintextSecret);

      const rotated = await rotateWebhookConsumer(created.data.id);
      expect(rotated.ok).toBe(true);
      if (!rotated.ok) throw new Error(rotated.error.message);
      expect(rotated.data.plaintextSecret).toMatch(/^[0-9a-f]{48}$/);
      expect(rotated.data.plaintextSecret).not.toBe(
        created.data.plaintextSecret,
      );
      expect(rotated.data.url).toBe(
        `https://sandra-sooty.vercel.app/api/webhooks/leads/${rotated.data.plaintextSecret}`,
      );

      const { data: row } = await testClient
        .from("webhook_consumers")
        .select("secret_hash")
        .eq("id", created.data.id)
        .single();
      // New hash is the new plaintext's hash; old plaintext no longer
      // matches.
      expect(row!.secret_hash).toBe(hashSecret(rotated.data.plaintextSecret));
      expect(row!.secret_hash).not.toBe(oldHash);
    });

    it("rotate on a provider consumer returns a /skip-trace/ URL", async () => {
      const created = await createWebhookConsumer({
        name: "Rotatable Provider",
        consumer_type: "provider",
      });
      if (!created.ok) throw new Error(created.error.message);

      const rotated = await rotateWebhookConsumer(created.data.id);
      expect(rotated.ok).toBe(true);
      if (!rotated.ok) throw new Error(rotated.error.message);
      expect(rotated.data.url).toContain("/api/webhooks/skip-trace/");
    });

    it("non-admin caller → FORBIDDEN", async () => {
      const created = await createWebhookConsumer({
        name: "Locked",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      if (!created.ok) throw new Error(created.error.message);
      const originalHash = hashSecret(created.data.plaintextSecret);

      currentEmail = "not-admin@example.com";
      const rotated = await rotateWebhookConsumer(created.data.id);
      expect(rotated.ok).toBe(false);
      if (rotated.ok) throw new Error("expected forbidden");
      expect(rotated.error.code).toBe("FORBIDDEN");

      // Hash unchanged.
      const { data: row } = await testClient
        .from("webhook_consumers")
        .select("secret_hash")
        .eq("id", created.data.id)
        .single();
      expect(row!.secret_hash).toBe(originalHash);
    });

    it("unknown id → WEBHOOK_NOT_FOUND", async () => {
      const rotated = await rotateWebhookConsumer(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(rotated.ok).toBe(false);
      if (rotated.ok) throw new Error("expected not-found");
      expect(rotated.error.code).toBe("WEBHOOK_NOT_FOUND");
    });
  });

  describe("toggleWebhookConsumer", () => {
    it("toggle(false) sets enabled=false AND revoked_at to a fresh timestamp", async () => {
      const created = await createWebhookConsumer({
        name: "Toggle Off",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      if (!created.ok) throw new Error(created.error.message);

      const before = Date.now();
      const result = await toggleWebhookConsumer(created.data.id, false);
      expect(result.ok).toBe(true);
      const after = Date.now();

      const { data: row } = await testClient
        .from("webhook_consumers")
        .select("enabled, revoked_at")
        .eq("id", created.data.id)
        .single();
      expect(row!.enabled).toBe(false);
      expect(row!.revoked_at).not.toBeNull();
      const ts = new Date(row!.revoked_at!).getTime();
      expect(ts).toBeGreaterThanOrEqual(before - 1_000);
      expect(ts).toBeLessThanOrEqual(after + 1_000);
    });

    it("toggle(true) sets enabled=true AND clears revoked_at", async () => {
      const created = await createWebhookConsumer({
        name: "Toggle On",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      if (!created.ok) throw new Error(created.error.message);

      // Disable first so we have a revoked_at to clear.
      await toggleWebhookConsumer(created.data.id, false);
      const { data: midRow } = await testClient
        .from("webhook_consumers")
        .select("revoked_at")
        .eq("id", created.data.id)
        .single();
      expect(midRow!.revoked_at).not.toBeNull();

      const result = await toggleWebhookConsumer(created.data.id, true);
      expect(result.ok).toBe(true);

      const { data: row } = await testClient
        .from("webhook_consumers")
        .select("enabled, revoked_at")
        .eq("id", created.data.id)
        .single();
      expect(row!.enabled).toBe(true);
      expect(row!.revoked_at).toBeNull();
    });

    it("non-admin caller → FORBIDDEN, no mutation", async () => {
      const created = await createWebhookConsumer({
        name: "Lockout",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      if (!created.ok) throw new Error(created.error.message);

      currentEmail = "not-admin@example.com";
      const result = await toggleWebhookConsumer(created.data.id, false);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected forbidden");
      expect(result.error.code).toBe("FORBIDDEN");

      const { data: row } = await testClient
        .from("webhook_consumers")
        .select("enabled, revoked_at")
        .eq("id", created.data.id)
        .single();
      expect(row!.enabled).toBe(true);
      expect(row!.revoked_at).toBeNull();
    });
  });

  describe("updateWebhookConsumerNotes", () => {
    it("updates the row's notes field", async () => {
      const created = await createWebhookConsumer({
        name: "Notesy",
        consumer_type: "lead",
        default_source: "cold_call",
      });
      if (!created.ok) throw new Error(created.error.message);

      const result = await updateWebhookConsumerNotes(
        created.data.id,
        "Set up by Jarrad on 2026-04-29; rotation due in 90 days.",
      );
      expect(result.ok).toBe(true);

      const { data: row } = await testClient
        .from("webhook_consumers")
        .select("notes")
        .eq("id", created.data.id)
        .single();
      expect(row!.notes).toBe(
        "Set up by Jarrad on 2026-04-29; rotation due in 90 days.",
      );
    });

    it("empty/whitespace notes are saved as NULL", async () => {
      const created = await createWebhookConsumer({
        name: "Notesy 2",
        consumer_type: "lead",
        default_source: "cold_call",
        notes: "starting note",
      });
      if (!created.ok) throw new Error(created.error.message);

      const result = await updateWebhookConsumerNotes(created.data.id, "   ");
      expect(result.ok).toBe(true);

      const { data: row } = await testClient
        .from("webhook_consumers")
        .select("notes")
        .eq("id", created.data.id)
        .single();
      expect(row!.notes).toBeNull();
    });

    it("non-admin caller → FORBIDDEN", async () => {
      const created = await createWebhookConsumer({
        name: "NoteLock",
        consumer_type: "lead",
        default_source: "cold_call",
        notes: "original",
      });
      if (!created.ok) throw new Error(created.error.message);

      currentEmail = "not-admin@example.com";
      const result = await updateWebhookConsumerNotes(
        created.data.id,
        "tampered",
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected forbidden");
      expect(result.error.code).toBe("FORBIDDEN");

      const { data: row } = await testClient
        .from("webhook_consumers")
        .select("notes")
        .eq("id", created.data.id)
        .single();
      expect(row!.notes).toBe("original");
    });
  });
});
