import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  calculateDistanceMeters,
  calculateHeading,
  resolveLeadMediaPresentation,
  type LeadMediaImages,
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
const resolverKeys = {
  staticKey: "static-key",
  metadataKey: "metadata-key",
  signingSecret,
};
const expectedSizes = {
  small: "320x341",
  mobile: "390x289",
  smallTablet: "640x230",
  tablet: "512x230",
  desktop: "640x208",
  wide: "640x156",
  large: "640x135",
  extraLarge: "640x125",
  ultra: "640x104",
} as const;

function metadataResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), { status });
}

function expectSignedImages(
  images: LeadMediaImages,
  expectedPath: string,
  assertions: (url: URL) => void,
) {
  for (const [breakpoint, expectedSize] of Object.entries(expectedSizes)) {
    const url = new URL(images[breakpoint as keyof LeadMediaImages]);
    expect(url.pathname).toBe(expectedPath);
    expect(url.searchParams.get("size")).toBe(expectedSize);
    expect(url.searchParams.get("key")).toBe("static-key");
    expectGoogleSignature(url);
    assertions(url);
  }
}

function expectGoogleSignature(url: URL) {
  const signature = url.searchParams.get("signature");
  expect(signature).toMatch(/^[A-Za-z0-9_-]+=*$/);
  url.searchParams.delete("signature");
  const decodedSecret = Buffer.from(signingSecret, "base64");
  const expected = createHmac("sha1", decodedSecret)
    .update(`${url.pathname}${url.search}`)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  expect(signature).toBe(expected);
}

describe("resolveLeadMediaPresentation", () => {
  it("returns signed responsive Street View and aerial images after coordinate metadata succeeds", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      metadataResponse({
        status: "OK",
        pano_id: "pano-123",
        location: { lat: 39.0997, lng: -94.5796 },
      }),
    );

    const result = await resolveLeadMediaPresentation(location, {
      ...resolverKeys,
      fetcher,
    });

    expect(result.kind).toBe("streetView");
    if (result.kind !== "streetView") throw new Error("expected Street View");
    expect(result).toMatchObject({
      panoramaId: "pano-123",
      aerialResolvedBy: "coordinates",
    });
    expect(result.heading).toBeCloseTo(90, 0);
    expectSignedImages(result.images, "/maps/api/streetview", (url) => {
      expect(url.searchParams.get("location")).toBe("39.0997,-94.5786");
      expect(url.searchParams.get("radius")).toBe("50");
      expect(url.searchParams.get("source")).toBe("outdoor");
      expect(url.searchParams.get("pitch")).toBe("0");
      expect(url.searchParams.get("fov")).toBe("80");
      expect(url.searchParams.get("return_error_code")).toBe("true");
      expect(url.searchParams.has("scale")).toBe(false);
      expect(url.searchParams.has("pano")).toBe(false);
      expect(url.searchParams.has("heading")).toBe(false);
    });
    expectSignedImages(result.aerialImages, "/maps/api/staticmap", (url) => {
      expect(url.searchParams.get("center")).toBe("39.0997,-94.5786");
      expect(url.searchParams.get("zoom")).toBe("19");
      expect(url.searchParams.get("maptype")).toBe("satellite");
      expect(url.searchParams.get("scale")).toBe("2");
    });

    const metadataUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(metadataUrl.searchParams.get("key")).toBe("metadata-key");
    expect(metadataUrl.searchParams.get("signature")).toBe(
      "S2Rac3e8Nl5-u1l2jXT8yF5Sfuo=",
    );
  });

  it("computes a normalized northbound heading", () => {
    expect(calculateHeading(38, -94, 39, -94)).toBeCloseTo(0, 5);
  });

  it("falls back to signed coordinate aerial imagery when coverage is unavailable", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(metadataResponse({ status: "ZERO_RESULTS" }));
    const result = await resolveLeadMediaPresentation(location, {
      ...resolverKeys,
      fetcher,
    });

    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "coordinates",
      fallbackReason: "no-coverage",
    });
    if (result.kind !== "aerial") throw new Error("expected aerial");
    expectSignedImages(result.images, "/maps/api/staticmap", (url) => {
      expect(url.searchParams.get("center")).toBe("39.0997,-94.5786");
      expect(url.searchParams.get("zoom")).toBe("19");
      expect(url.searchParams.get("maptype")).toBe("satellite");
      expect(url.searchParams.get("scale")).toBe("2");
    });
  });

  it("uses the complete address for metadata and auto-aimed Street View images", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      metadataResponse({
        status: "OK",
        pano_id: "address-pano",
        location: { lat: 39.0999, lng: -94.5787 },
      }),
    );
    const result = await resolveLeadMediaPresentation(
      { ...location, lat: null, lon: null },
      { ...resolverKeys, fetcher },
    );

    expect(result).toMatchObject({
      kind: "streetView",
      panoramaId: "address-pano",
      heading: null,
      aerialResolvedBy: "address",
    });
    if (result.kind !== "streetView") throw new Error("expected Street View");
    const completeAddress = "100 Sample St, Kansas City, MO 64106";
    const metadataUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(metadataUrl.searchParams.get("location")).toBe(completeAddress);
    expect(metadataUrl.searchParams.get("radius")).toBe("50");
    expect(metadataUrl.searchParams.get("source")).toBe("outdoor");
    expect(metadataUrl.searchParams.get("key")).toBe("metadata-key");
    expect(metadataUrl.searchParams.get("signature")).toBe(
      "BeyM6ThVlEUdAXcxVZakP9XGHIE=",
    );
    expectSignedImages(result.images, "/maps/api/streetview", (url) => {
      expect(url.searchParams.get("location")).toBe(completeAddress);
      expect(url.searchParams.has("pano")).toBe(false);
      expect(url.searchParams.has("heading")).toBe(false);
      expect(url.searchParams.has("scale")).toBe(false);
    });
    expectSignedImages(result.aerialImages, "/maps/api/staticmap", (url) => {
      expect(url.searchParams.get("center")).toBe(completeAddress);
      expect(url.searchParams.get("scale")).toBe("2");
    });
  });

  it("falls back to signed address aerial imagery when address coverage is unavailable", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(metadataResponse({ status: "ZERO_RESULTS" }));
    const result = await resolveLeadMediaPresentation(
      { ...location, lat: null, lon: null },
      { ...resolverKeys, fetcher },
    );

    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "address",
      fallbackReason: "no-coverage",
    });
    if (result.kind !== "aerial") throw new Error("expected aerial");
    expectSignedImages(result.images, "/maps/api/staticmap", (url) => {
      expect(url.searchParams.get("center")).toBe(
        "100 Sample St, Kansas City, MO 64106",
      );
    });
  });

  it("treats placeholder coordinates as missing and uses the address", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(metadataResponse({ status: "ZERO_RESULTS" }));
    const result = await resolveLeadMediaPresentation(
      { ...location, lat: 0, lon: 0 },
      { ...resolverKeys, fetcher },
    );
    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "address",
      fallbackReason: "no-coverage",
    });
  });

  it("uses the flat fallback for an incomplete address with no coordinates", async () => {
    const result = await resolveLeadMediaPresentation(
      { ...location, lat: null, lon: null, city: null },
      resolverKeys,
    );
    expect(result).toEqual({ kind: "flat", reason: "missing-location" });
  });

  it("uses the flat fallback for a structurally malformed address", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await resolveLeadMediaPresentation(
      {
        ...location,
        lat: null,
        lon: null,
        address: "Unknown",
        state: "Missouri",
        zip: "not-a-zip",
      },
      { ...resolverKeys, fetcher },
    );
    expect(result).toEqual({ kind: "flat", reason: "missing-location" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies metadata failures before using signed aerial imagery", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(metadataResponse({ status: "REQUEST_DENIED" }));
    const result = await resolveLeadMediaPresentation(location, {
      ...resolverKeys,
      fetcher,
    });
    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "coordinates",
      fallbackReason: "metadata-failure",
    });
  });

  it("fails flat without making unsigned requests when the signing secret is absent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await resolveLeadMediaPresentation(location, {
      staticKey: "static-key",
      metadataKey: "metadata-key",
      signingSecret: "",
      fetcher,
    });
    expect(result).toEqual({
      kind: "flat",
      reason: "missing-signing-secret",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses signed aerial imagery without metadata calls when the metadata key is absent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await resolveLeadMediaPresentation(location, {
      staticKey: "static-key",
      metadataKey: "",
      signingSecret,
      fetcher,
    });
    expect(result).toMatchObject({
      kind: "aerial",
      resolvedBy: "coordinates",
      fallbackReason: "missing-metadata-key",
    });
    expect(fetcher).not.toHaveBeenCalled();
    if (result.kind !== "aerial") throw new Error("expected aerial");
    expectSignedImages(result.images, "/maps/api/staticmap", (url) => {
      expect(url.searchParams.get("scale")).toBe("2");
    });
  });

  it("uses the flat fallback when the static API key is absent", async () => {
    const result = await resolveLeadMediaPresentation(location, {
      staticKey: "",
      metadataKey: "metadata-key",
      signingSecret,
    });
    expect(result).toEqual({ kind: "flat", reason: "missing-static-key" });
  });

  it("classifies an HTTP metadata failure before using aerial imagery", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(metadataResponse({}, 403));
    const result = await resolveLeadMediaPresentation(location, {
      ...resolverKeys,
      fetcher,
    });
    expect(result).toMatchObject({
      kind: "aerial",
      fallbackReason: "metadata-failure",
    });
  });

  it("uses a stable north heading when the panorama is effectively on the property", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      metadataResponse({
        status: "OK",
        pano_id: "same-place",
        location: { lat: location.lat, lng: location.lon },
      }),
    );
    const result = await resolveLeadMediaPresentation(location, {
      ...resolverKeys,
      fetcher,
    });
    expect(result).toMatchObject({ kind: "streetView", heading: 0 });
    expect(calculateDistanceMeters(39, -94, 39, -94)).toBe(0);
  });
});
