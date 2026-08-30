import { describe, expect, it } from "vitest";

import {
  selectLatestContract,
  type ContractStatusRecord,
} from "./contract-status";

const contract = (
  id: string,
  createdAt: string,
  status: ContractStatusRecord["status"] = "awaiting",
): ContractStatusRecord => ({ id, created_at: createdAt, status });

describe("selectLatestContract", () => {
  it("returns null when a property has no contracts", () => {
    expect(selectLatestContract([])).toBeNull();
  });

  it("returns the only contract", () => {
    const only = contract("request-1", "2026-08-29T12:00:00.000Z");

    expect(selectLatestContract([only])).toBe(only);
  });

  it("selects the newest created_at regardless of input order", () => {
    const older = contract("request-2", "2026-08-29T12:00:00.000Z");
    const newer = contract("request-1", "2026-08-29T12:00:01.000Z", "viewed");

    expect(selectLatestContract([newer, older])).toBe(newer);
  });

  it("uses id descending as the deterministic same-timestamp tie-breaker", () => {
    const lowerId = contract(
      "00000000-0000-0000-0000-000000000101",
      "2026-08-29T12:00:00.000Z",
    );
    const higherId = contract(
      "00000000-0000-0000-0000-000000000102",
      "2026-08-29T12:00:00.000Z",
      "viewed",
    );

    expect(selectLatestContract([higherId, lowerId])).toBe(higherId);
    expect(selectLatestContract([lowerId, higherId])).toBe(higherId);
  });

  it("compares timestamp instants across equivalent timezone representations", () => {
    const lowerId = contract(
      "00000000-0000-0000-0000-000000000101",
      "2026-08-29T12:00:00.000000Z",
    );
    const higherId = contract(
      "00000000-0000-0000-0000-000000000102",
      "2026-08-29T07:00:00-05:00",
      "viewed",
    );

    expect(selectLatestContract([lowerId, higherId])).toBe(higherId);
  });

  it("preserves PostgreSQL microsecond ordering", () => {
    const older = contract(
      "request-z",
      "2026-08-29T12:00:00.000001+00:00",
    );
    const newer = contract(
      "request-a",
      "2026-08-29T12:00:00.000002+00:00",
      "viewed",
    );

    expect(selectLatestContract([newer, older])).toBe(newer);
  });

  it("rejects malformed timestamps instead of inventing an ordering", () => {
    for (const createdAt of [
      "not-a-timestamp",
      "2026-02-30T12:00:00Z",
      "2026-04-31T12:00:00+00:00",
    ]) {
      expect(() =>
        selectLatestContract([contract("request-1", createdAt)]),
      ).toThrow(/PostgreSQL timestamp/i);
    }
  });

  it("selects a newer retry row instead of its original request", () => {
    const original = contract(
      "00000000-0000-0000-0000-000000000201",
      "2026-08-29T12:00:00.000Z",
      "error",
    );
    const retry = {
      ...contract(
        "00000000-0000-0000-0000-000000000202",
        "2026-08-29T12:05:00.000Z",
      ),
      retry_of_request_id: original.id,
    };

    expect(selectLatestContract([retry, original])).toBe(retry);
  });

  it("does not mutate the caller's order", () => {
    const older = contract("request-1", "2026-08-29T12:00:00.000Z");
    const newer = contract("request-2", "2026-08-29T12:01:00.000Z");
    const requests = [older, newer] as const;

    selectLatestContract(requests);

    expect(requests).toEqual([older, newer]);
  });
});
