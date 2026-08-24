import { createHmac } from "node:crypto";

export type LeadMediaPresentation =
  | {
      kind: "streetView";
      embedUrl: string;
      heading: number;
      panoramaId: string;
    }
  | {
      kind: "aerial";
      embedUrl: string;
      resolvedBy: "coordinates" | "address";
      fallbackReason:
        | "no-coverage"
        | "metadata-failure"
        | "missing-metadata-key"
        | "missing-coordinates";
    }
  | {
      kind: "flat";
      reason: "missing-embed-key" | "missing-location";
    };

export type LeadMediaLocation = {
  lat: number | null;
  lon: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

type StreetViewMetadata = {
  status?: string;
  pano_id?: string;
  location?: { lat?: number; lng?: number };
};

type StreetViewMetadataResult =
  | {
      kind: "found";
      pano_id: string;
      location: { lat: number; lng: number };
    }
  | { kind: "no-coverage" }
  | { kind: "failure"; status: string };

type LeadMediaResolverOptions = {
  embedKey?: string;
  metadataKey?: string;
  signingSecret?: string;
  fetcher?: typeof fetch;
};

const EMBED_BASE = "https://www.google.com/maps/embed/v1";
const STREET_VIEW_METADATA_BASE =
  "https://maps.googleapis.com/maps/api/streetview/metadata";
const STREET_VIEW_METADATA_RADIUS_METERS = 50;
const STREET_VIEW_METADATA_TIMEOUT_MS = 4_000;
const STREET_VIEW_METADATA_CACHE_TTL_MS = 15 * 60 * 1_000;
const UNSTABLE_HEADING_DISTANCE_METERS = 3;
const metadataCache = new Map<
  string,
  { expiresAt: number; result: StreetViewMetadataResult }
>();

export async function resolveLeadMediaPresentation(
  location: LeadMediaLocation,
  options: LeadMediaResolverOptions = {},
): Promise<LeadMediaPresentation> {
  const embedKey = options.embedKey ?? process.env.GOOGLE_MAPS_EMBED_KEY;
  if (!embedKey) return { kind: "flat", reason: "missing-embed-key" };

  const coordinates = normalizeCoordinates(location.lat, location.lon);
  const metadataKey =
    options.metadataKey ?? process.env.GOOGLE_STREET_VIEW_METADATA_KEY;

  let aerialFallbackReason: Extract<
    LeadMediaPresentation,
    { kind: "aerial" }
  >["fallbackReason"] = metadataKey
    ? "metadata-failure"
    : "missing-metadata-key";

  if (coordinates && metadataKey) {
    const metadata = await loadStreetViewMetadata(coordinates, {
      metadataKey,
      signingSecret:
        options.signingSecret ??
        process.env.GOOGLE_MAPS_URL_SIGNING_SECRET ??
        undefined,
      fetcher: options.fetcher ?? fetch,
      cacheEnabled: options.fetcher === undefined,
    });
    if (metadata.kind === "found") {
      const panoramaDistance = calculateDistanceMeters(
        metadata.location.lat,
        metadata.location.lng,
        coordinates.lat,
        coordinates.lon,
      );
      const heading =
        panoramaDistance < UNSTABLE_HEADING_DISTANCE_METERS
          ? 0
          : calculateHeading(
              metadata.location.lat,
              metadata.location.lng,
              coordinates.lat,
              coordinates.lon,
            );
      const params = new URLSearchParams({
        key: embedKey,
        pano: metadata.pano_id,
        heading: heading.toFixed(1),
        pitch: "0",
        fov: "80",
      });
      return {
        kind: "streetView",
        embedUrl: `${EMBED_BASE}/streetview?${params.toString()}`,
        heading,
        panoramaId: metadata.pano_id,
      };
    }
    aerialFallbackReason =
      metadata.kind === "no-coverage" ? "no-coverage" : "metadata-failure";
  }

  if (coordinates) {
    const params = new URLSearchParams({
      key: embedKey,
      center: `${coordinates.lat},${coordinates.lon}`,
      zoom: "19",
      maptype: "satellite",
    });
    return {
      kind: "aerial",
      embedUrl: `${EMBED_BASE}/view?${params.toString()}`,
      resolvedBy: "coordinates",
      fallbackReason: aerialFallbackReason,
    };
  }

  const completeAddress = formatCompleteAddress(location);
  if (completeAddress) {
    const params = new URLSearchParams({
      key: embedKey,
      q: completeAddress,
      zoom: "19",
      maptype: "satellite",
    });
    return {
      kind: "aerial",
      embedUrl: `${EMBED_BASE}/place?${params.toString()}`,
      resolvedBy: "address",
      fallbackReason: "missing-coordinates",
    };
  }

  return { kind: "flat", reason: "missing-location" };
}

export function calculateHeading(
  panoramaLat: number,
  panoramaLon: number,
  propertyLat: number,
  propertyLon: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const toDegrees = (radians: number) => (radians * 180) / Math.PI;
  const startLat = toRadians(panoramaLat);
  const endLat = toRadians(propertyLat);
  const longitudeDelta = toRadians(propertyLon - panoramaLon);
  const y = Math.sin(longitudeDelta) * Math.cos(endLat);
  const x =
    Math.cos(startLat) * Math.sin(endLat) -
    Math.sin(startLat) * Math.cos(endLat) * Math.cos(longitudeDelta);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

export function calculateDistanceMeters(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(endLat - startLat);
  const longitudeDelta = toRadians(endLon - startLon);
  const startLatitude = toRadians(startLat);
  const endLatitude = toRadians(endLat);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return (
    6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

async function loadStreetViewMetadata(
  coordinates: { lat: number; lon: number },
  options: {
    metadataKey: string;
    signingSecret?: string;
    fetcher: typeof fetch;
    cacheEnabled: boolean;
  },
): Promise<StreetViewMetadataResult> {
  const cacheKey = `${coordinates.lat.toFixed(5)},${coordinates.lon.toFixed(5)}`;
  const cached = options.cacheEnabled ? metadataCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (cached) metadataCache.delete(cacheKey);

  const url = new URL(STREET_VIEW_METADATA_BASE);
  url.searchParams.set("location", `${coordinates.lat},${coordinates.lon}`);
  url.searchParams.set("radius", String(STREET_VIEW_METADATA_RADIUS_METERS));
  url.searchParams.set("source", "outdoor");
  url.searchParams.set("key", options.metadataKey);
  if (options.signingSecret) {
    url.searchParams.set(
      "signature",
      signGoogleMapsUrl(url, options.signingSecret),
    );
  }

  try {
    const response = await options.fetcher(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(STREET_VIEW_METADATA_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[lead-media] Street View metadata request failed", {
        status: `HTTP_${response.status}`,
      });
      return { kind: "failure", status: `HTTP_${response.status}` };
    }
    const metadata = (await response.json()) as StreetViewMetadata;
    if (metadata.status === "ZERO_RESULTS" || metadata.status === "NOT_FOUND") {
      const result = { kind: "no-coverage" } as const;
      if (options.cacheEnabled) cacheMetadataResult(cacheKey, result);
      return result;
    }
    if (
      metadata.status !== "OK" ||
      !metadata.pano_id ||
      !Number.isFinite(metadata.location?.lat) ||
      !Number.isFinite(metadata.location?.lng)
    ) {
      const status = metadata.status ?? "MALFORMED_RESPONSE";
      console.error("[lead-media] Street View metadata unavailable", {
        status,
      });
      return { kind: "failure", status };
    }
    const result = {
      kind: "found",
      pano_id: metadata.pano_id,
      location: {
        lat: metadata.location!.lat!,
        lng: metadata.location!.lng!,
      },
    } as const;
    if (options.cacheEnabled) cacheMetadataResult(cacheKey, result);
    return result;
  } catch (error) {
    const status =
      error instanceof DOMException && error.name === "TimeoutError"
        ? "TIMEOUT"
        : "FETCH_ERROR";
    console.error("[lead-media] Street View metadata request failed", {
      status,
    });
    return { kind: "failure", status };
  }
}

function cacheMetadataResult(
  key: string,
  result: Extract<StreetViewMetadataResult, { kind: "found" | "no-coverage" }>,
) {
  metadataCache.set(key, {
    expiresAt: Date.now() + STREET_VIEW_METADATA_CACHE_TTL_MS,
    result,
  });
  if (metadataCache.size > 500) {
    const oldestKey = metadataCache.keys().next().value as string | undefined;
    if (oldestKey) metadataCache.delete(oldestKey);
  }
}

function signGoogleMapsUrl(url: URL, signingSecret: string): string {
  const decodedSecret = Buffer.from(
    signingSecret.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  );
  return createHmac("sha1", decodedSecret)
    .update(`${url.pathname}${url.search}`)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function normalizeCoordinates(
  lat: number | null,
  lon: number | null,
): { lat: number; lon: number } | null {
  if (
    typeof lat !== "number" ||
    typeof lon !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    (lat === 0 && lon === 0) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return null;
  }
  return { lat, lon };
}

function formatCompleteAddress(location: LeadMediaLocation): string | null {
  const parts = [location.address, location.city, location.state, location.zip]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean);
  if (parts.length !== 4 || parts.some((part) => part.length > 160))
    return null;
  return `${parts[0]}, ${parts[1]}, ${parts[2]} ${parts[3]}`;
}
