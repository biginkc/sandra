import { describe, expect, it, vi } from "vitest";

import {
  calculateDistanceMeters,
  calculateHeading,
  resolveLeadMediaPresentation,
  type LeadMediaLocation,
} from "./lead-media";

const location: LeadMediaLocation = {
  lat: 39.0997,
  lon: -94.5786,
  address: "100 Sample St",
  city: "Kansas City",
  state: "MO",
  zip: "64106",
};
const signingSecret = "dGVzdC1zaWduaW5nLXNlY3JldA==";

describe("resolveLeadMediaPresentation", () => {
  it("uses Street View metadata and calculates the panorama heading", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "OK",
          pano_id: "pano-123",
          location: { lat: 39.0997, lng: -94.5796 },
        }),
        { status: 200 },
      ),
    );

    const result = await resolveLeadMediaPresentation(location, {
      embedKey: "embed-key",
      metadataKey: "metadata-key",
      signingSecret,
      fetcher,
    });

    expect(result.kind).toBe("streetView");
    expect(result).toMatchObject({ panoramaId: "pano-123" });
    expect(result.kind === "streetView" ? result.heading : null).toBeCloseTo(
      90,
      0,
    );
    expect(result.kind === "streetView" ? result.embedUrl : "").toContain(
      "/streetview?",
    );
    const metadataUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(metadataUrl.searchParams.get("signature")).toBe(
      "S2Rac3e8Nl5-u1l2jXT8yF5Sfuo=",
    );
  });

  it("computes a normalized northbound heading", () => {
    expect(calculateHeading(38, -94, 39, -94)).toBeCloseTo(0, 5);
  });

  it("falls back to coordinate aerial imagery when coverage is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ZERO_RESULTS" }), {
        status: 200,
      }),
    );
    const result = await resolveLeadMediaPresentation(location, {
      embedKey: "embed-key",
      metadataKey: "metadata-key",
      signingSecret,
      fetcher,
    });
    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "coordinates",
      fallbackReason: "no-coverage",
    });
    expect(result.kind === "aerial" ? result.embedUrl : "").toContain(
      "maptype=satellite",
    );
  });

  it("resolves missing coordinates through a complete address", async () => {
    const result = await resolveLeadMediaPresentation(
      { ...location, lat: null, lon: null },
      { embedKey: "embed-key", metadataKey: "metadata-key" },
    );
    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "address",
      fallbackReason: "missing-coordinates",
    });
    expect(result.kind === "aerial" ? result.embedUrl : "").toContain(
      "100+Sample+St%2C+Kansas+City%2C+MO+64106",
    );
  });

  it("treats the placeholder coordinate 0,0 as missing and resolves by address", async () => {
    const result = await resolveLeadMediaPresentation(
      { ...location, lat: 0, lon: 0 },
      { embedKey: "embed-key", metadataKey: "metadata-key" },
    );
    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "address",
      fallbackReason: "missing-coordinates",
    });
  });

  it("uses the flat fallback for an incomplete address with no coordinates", async () => {
    const result = await resolveLeadMediaPresentation(
      { ...location, lat: null, lon: null, city: null },
      { embedKey: "embed-key", metadataKey: "metadata-key" },
    );
    expect(result).toEqual({ kind: "flat", reason: "missing-location" });
  });

  it("uses the flat fallback for a structurally malformed address", async () => {
    const result = await resolveLeadMediaPresentation(
      {
        ...location,
        lat: null,
        lon: null,
        address: "Unknown",
        state: "Missouri",
        zip: "not-a-zip",
      },
      { embedKey: "embed-key", metadataKey: "metadata-key", signingSecret },
    );
    expect(result).toEqual({ kind: "flat", reason: "missing-location" });
  });

  it("uses the flat fallback when the browser embed key is absent", async () => {
    const result = await resolveLeadMediaPresentation(location, {
      embedKey: "",
      metadataKey: "metadata-key",
    });
    expect(result).toEqual({ kind: "flat", reason: "missing-embed-key" });
  });

  it("uses aerial imagery without calling metadata when the metadata key is absent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await resolveLeadMediaPresentation(location, {
      embedKey: "embed-key",
      metadataKey: "",
      fetcher,
    });
    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "coordinates",
      fallbackReason: "missing-metadata-key",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not make an unsigned metadata request when the signing secret is absent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await resolveLeadMediaPresentation(location, {
      embedKey: "embed-key",
      metadataKey: "metadata-key",
      signingSecret: "",
      fetcher,
    });
    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "coordinates",
      fallbackReason: "missing-signing-secret",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("distinguishes metadata misconfiguration from real zero coverage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "REQUEST_DENIED" }), {
        status: 200,
      }),
    );
    const result = await resolveLeadMediaPresentation(location, {
      embedKey: "embed-key",
      metadataKey: "metadata-key",
      signingSecret,
      fetcher,
    });
    expect(result).toMatchObject({
      kind: "aerial",
      fallbackReason: "metadata-failure",
    });
  });

  it("uses a stable north heading when the panorama is effectively on the property", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "OK",
          pano_id: "same-place",
          location: { lat: location.lat, lng: location.lon },
        }),
        { status: 200 },
      ),
    );
    const result = await resolveLeadMediaPresentation(location, {
      embedKey: "embed-key",
      metadataKey: "metadata-key",
      signingSecret,
      fetcher,
    });
    expect(result).toMatchObject({ kind: "streetView", heading: 0 });
    expect(calculateDistanceMeters(39, -94, 39, -94)).toBe(0);
  });
});
