import { describe, expect, it, vi } from "vitest";

import { hasProofOfDelivery, resolveProofLink } from "./proof-link";

const ORG = "org-1";
const NOW = Date.parse("2026-10-21T12:00:00Z");
const row = (o: Record<string, unknown> = {}) => ({
  org_id: ORG, proof_url: "https://proof.example/r/t", proof_url_at: "2026-10-20T12:00:00Z",
  completed_at: "2026-10-20T11:00:00Z", proof_storage_path: null as string | null, ...o,
});

describe("resolveProofLink", () => {
  it("signs the stored copy first", async () => {
    const sign = vi.fn(async () => "https://storage/signed");
    expect(await resolveProofLink(row({ proof_storage_path: `${ORG}/d.mp3` }), sign, NOW)).toBe("https://storage/signed");
    expect(sign).toHaveBeenCalledWith(`${ORG}/d.mp3`, 60);
  });

  it("never signs a path outside the drop's org", async () => {
    const sign = vi.fn(async () => "https://storage/signed");
    expect(await resolveProofLink(row({ proof_storage_path: "org-2/d.mp3" }), sign, NOW)).toBe("https://proof.example/r/t");
    expect(sign).not.toHaveBeenCalled();
  });

  it("falls back to the provider link within 7 days, then nothing", async () => {
    const sign = vi.fn(async () => null);
    expect(await resolveProofLink(row(), sign, NOW)).toBe("https://proof.example/r/t");
    expect(await resolveProofLink(row({ proof_url_at: "2026-10-14T11:59:00Z" }), sign, NOW)).toBeNull();
    expect(await resolveProofLink(row({ proof_url: "javascript:alert(1)" }), sign, NOW)).toBeNull();
  });
});

describe("hasProofOfDelivery", () => {
  it("is true for a stored copy even after the provider link expired", () => {
    expect(hasProofOfDelivery(row({ proof_url_at: "2026-01-01T00:00:00Z", proof_storage_path: `${ORG}/d.mp3` }), NOW)).toBe(true);
    expect(hasProofOfDelivery(row({ proof_url_at: "2026-01-01T00:00:00Z" }), NOW)).toBe(false);
  });
});
