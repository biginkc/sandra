import { describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";
import { classifyProviderFailure } from "@/lib/esign/provider-failure";

const authMocks = vi.hoisted(() => ({
  getSingleActiveMembership: vi.fn(),
}));

const supabaseMocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/memberships", () => ({
  getSingleActiveMembership: authMocks.getSingleActiveMembership,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: supabaseMocks.createAdminClient,
}));

import {
  authenticateLeadEsignActor,
  consumedRetryRequestIds,
  createLeadEsignRepository,
  isConsumedRetryConstraint,
  mapAtomicSendBlocker,
  mapProviderMutationClaimOutcome,
} from "./lead-esign-bindings";

describe("lead eSign actor membership gate", () => {
  it("resolves a single active membership into the eSign actor", async () => {
    authMocks.getSingleActiveMembership.mockResolvedValueOnce({
      ok: true,
      membership: { user_id: "owner-1", org_id: "org-1", role: "owner" },
    });

    await expect(authenticateLeadEsignActor()).resolves.toEqual({
      orgId: "org-1",
      userId: "owner-1",
      role: "owner",
    });
  });

  it.each(["missing", "ambiguous"] as const)(
    "fails closed before eSign work when membership resolution is %s",
    async (reason) => {
      authMocks.getSingleActiveMembership.mockResolvedValueOnce({
        ok: false,
        reason,
      });

      await expect(authenticateLeadEsignActor()).resolves.toBeNull();
    },
  );
});

describe("lead eSign send context", () => {
  it("treats a credentialless integration tombstone as disconnected and sending disabled", async () => {
    const admin = {
      from: vi.fn((table: string) => {
        if (table === "properties") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: "property-1",
                      org_id: "org-1",
                      address: "123 Main",
                      city: "Springfield",
                      state: "MO",
                      zip: "65801",
                      homeowner_contact_id: "contact-1",
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      first_name: "Sally",
                      last_name: "Seller",
                      entity_name: null,
                      contact_type: "person",
                      email: "seller@example.com",
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "org_esign_integrations") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    api_key_last_four: null,
                    sending_enabled: true,
                    test_mode: false,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "available_esign_templates") {
          return {
            select: () => ({
              eq: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    supabaseMocks.createAdminClient.mockReturnValueOnce(admin);

    await expect(
      createLeadEsignRepository().loadLeadSendContext({
        actor: { orgId: "org-1", userId: "user-1", role: "owner" },
        propertyId: "property-1",
      }),
    ).resolves.toMatchObject({
      connected: false,
      sendingEnabled: false,
      sellerEmailAddress: "seller@example.com",
    });
  });
});

describe("atomic eSign send blocker mapping", () => {
  it.each([
    ["ACTIVE_MEMBERSHIP_REQUIRED", "authorization_changed"],
    ["PROPERTY_NOT_FOUND", "not_found"],
    ["SIGNER_PAYLOAD_INVALID", "invalid_send_input"],
    ["SELLER_EMAIL_CONFLICT", "seller_contact_conflict"],
  ] as const)("maps %s to the distinct safe %s outcome", (code, outcome) => {
    const result = mapAtomicSendBlocker(code);
    expect(result).toEqual({ outcome });
    expect(JSON.stringify(result)).not.toMatch(/property id|email|address/i);
  });
});

describe("atomic retry consumption binding", () => {
  it("maps only the exact retry-lineage uniqueness violation", () => {
    expect(
      isConsumedRetryConstraint(
        {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "esign_requests_one_retry_child_per_source_idx"',
        },
        "failed-source-1",
      ),
    ).toBe(true);
    expect(
      isConsumedRetryConstraint(
        { code: "23505", message: "another_unique_constraint" },
        "failed-source-1",
      ),
    ).toBe(false);
    expect(
      isConsumedRetryConstraint(
        {
          code: "23505",
          message: "esign_requests_one_retry_child_per_source_idx",
        },
        null,
      ),
    ).toBe(false);
  });

  it("marks only failed sources that already have a child", () => {
    expect(
      [...consumedRetryRequestIds([
        { retry_of_request_id: null },
        { retry_of_request_id: "failed-source-1" },
        { retry_of_request_id: "failed-source-2" },
      ])],
    ).toEqual(["failed-source-1", "failed-source-2"]);
  });
});

describe("provider mutation claim binding", () => {
  it.each(["in_progress", "reconciliation_required"] as const)(
    "maps %s without loading a claim candidate",
    (outcome) => {
      expect(mapProviderMutationClaimOutcome(outcome)).toEqual({ outcome });
    },
  );

  it("leaves ordinary claim outcomes to the candidate mapper", () => {
    expect(mapProviderMutationClaimOutcome("claimed")).toBeNull();
    expect(mapProviderMutationClaimOutcome("ineligible")).toBeNull();
  });
});

describe("shared provider failure classification", () => {
  it.each([
    [408, false],
    [429, false],
    [500, false],
    [503, true],
  ] as const)("classifies HTTP %s as ambiguous", (statusCode, retryable) => {
    expect(
      classifyProviderFailure(
        new ProviderError("provider failed", "dropbox_sign", {
          statusCode,
          retryable,
        }),
      ),
    ).toBe("ambiguous");
  });

  it.each([400, 401, 403, 404, 409, 422] as const)(
    "classifies terminal HTTP %s as definitive failure",
    (statusCode) => {
      expect(
        classifyProviderFailure(
          new ProviderError("provider failed", "dropbox_sign", {
            statusCode,
            retryable: false,
          }),
        ),
      ).toBe("definitive_failure");
    },
  );

  it.each([
    new Error("network failure"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
  ])("classifies unknown/network/abort failures as ambiguous", (error) => {
    expect(classifyProviderFailure(error)).toBe("ambiguous");
  });

  it.each([409, 422] as const)(
    "classifies non-retryable HTTP %s definitively for send as well as reminder/void",
    (statusCode) => {
      const error = new ProviderError("provider failed", "dropbox_sign", {
        statusCode,
        retryable: false,
      });
      expect({ outcome: classifyProviderFailure(error) }).toEqual({
        outcome: "definitive_failure",
      });
    },
  );
});
