import { describe, expect, it } from "vitest";

import { ProviderError } from "@/lib/errors/classes";
import { classifyProviderFailure } from "@/lib/esign/provider-failure";

import {
  consumedRetryRequestIds,
  isConsumedRetryConstraint,
  mapAtomicSendBlocker,
  mapProviderMutationClaimOutcome,
} from "./lead-esign-bindings";

describe("atomic eSign send blocker mapping", () => {
  it.each([
    ["ACTIVE_MEMBERSHIP_REQUIRED", "authorization_changed"],
    ["PROPERTY_NOT_FOUND", "not_found"],
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
