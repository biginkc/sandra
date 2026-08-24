import { createHmac } from "node:crypto";

export type LeadMediaPresentation =
  | {
      kind: "streetView";
      images: LeadMediaImages;
      aerialImages: LeadMediaImages;
      aerialResolvedBy: "coordinates" | "address";
      heading: number | null;
      panoramaId: string;
    }
  | {
      kind: "aerial";
      images: LeadMediaImages;
      resolvedBy: "coordinates" | "address";
      fallbackReason:
        "no-coverage" | "metadata-failure" | "missing-metadata-key";
    }
  | {
      kind: "flat";
      reason:
        "missing-static-key" | "missing-signing-secret" | "missing-location";
    };

export type LeadMediaImages = {
  small: string;
  mobile: string;
  smallTablet: string;
  tablet: string;
  desktop: string;
  wide: string;
  large: string;
  extraLarge: string;
  ultra: string;
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
  staticKey?: string;
  metadataKey?: string;
  signingSecret?: string;
  fetcher?: typeof fetch;
};

const STREET_VIEW_STATIC_BASE =
  "https://maps.googleapis.com/maps/api/streetview";
const STATIC_MAP_BASE = "https://maps.googleapis.com/maps/api/staticmap";
const STREET_VIEW_METADATA_BASE =
  "https://maps.googleapis.com/maps/api/streetview/metadata";
const STREET_VIEW_METADATA_RADIUS_METERS = 50;
const STREET_VIEW_METADATA_TIMEOUT_MS = 4_000;
const STREET_VIEW_METADATA_CACHE_TTL_MS = 15 * 60 * 1_000;
const UNSTABLE_HEADING_DISTANCE_METERS = 3;
const STATIC_IMAGE_SIZES = {
  // Mobile hero height is content-driven because the full action set wraps.
  // These ratios match the measured 320px and 390px production layouts.
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
const metadataCache = new Map<
  string,
  { expiresAt: number; result: StreetViewMetadataResult }
>();

export async function resolveLeadMediaPresentation(
  location: LeadMediaLocation,
  options: LeadMediaResolverOptions = {},
): Promise<LeadMediaPresentation> {
  const staticKey = options.staticKey ?? process.env.GOOGLE_MAPS_STATIC_KEY;
  if (!staticKey) return { kind: "flat", reason: "missing-static-key" };

  const coordinates = normalizeCoordinates(location.lat, location.lon);
  const completeAddress = formatCompleteAddress(location);
  if (!coordinates && !completeAddress) {
    return { kind: "flat", reason: "missing-location" };
  }

  const metadataKey =
    options.metadataKey ?? process.env.GOOGLE_STREET_VIEW_METADATA_KEY;
  const signingSecret =
    options.signingSecret ??
    process.env.GOOGLE_MAPS_URL_SIGNING_SECRET ??
    undefined;
  if (!signingSecret) {
    return { kind: "flat", reason: "missing-signing-secret" };
  }

  let aerialFallbackReason: Extract<
    LeadMediaPresentation,
    { kind: "aerial" }
  >["fallbackReason"] = !metadataKey
    ? "missing-metadata-key"
    : "metadata-failure";

  const streetViewLookup = coordinates
    ? `${coordinates.lat},${coordinates.lon}`
    : completeAddress;

  if (streetViewLookup && metadataKey) {
    const metadata = await loadStreetViewMetadata(streetViewLookup, {
      metadataKey,
      signingSecret,
      fetcher: options.fetcher ?? fetch,
      cacheEnabled: options.fetcher === undefined,
    });
    if (metadata.kind === "found") {
      const panoramaDistance = coordinates
        ? calculateDistanceMeters(
            metadata.location.lat,
            metadata.location.lng,
            coordinates.lat,
            coordinates.lon,
          )
        : null;
      const heading = coordinates
        ? panoramaDistance! < UNSTABLE_HEADING_DISTANCE_METERS
          ? 0
          : calculateHeading(
              metadata.location.lat,
              metadata.location.lng,
              coordinates.lat,
              coordinates.lon,
            )
        : null;
      const images = buildStreetViewImages({
        coordinates,
        completeAddress,
        staticKey,
        signingSecret,
      });
      const aerial = buildAerialImages({
        coordinates,
        completeAddress,
        staticKey,
        signingSecret,
      });
      return {
        kind: "streetView",
        images,
        aerialImages: aerial.images,
        aerialResolvedBy: aerial.resolvedBy,
        heading,
        panoramaId: metadata.pano_id,
      };
    }
    aerialFallbackReason =
      metadata.kind === "no-coverage" ? "no-coverage" : "metadata-failure";
  }

  const aerial = buildAerialImages({
    coordinates,
    completeAddress,
    staticKey,
    signingSecret,
  });
  return {
    kind: "aerial",
    images: aerial.images,
    resolvedBy: aerial.resolvedBy,
    fallbackReason: aerialFallbackReason,
  };
}

function buildStreetViewImages(options: {
  coordinates: { lat: number; lon: number } | null;
  completeAddress: string | null;
  staticKey: string;
  signingSecret: string;
}): LeadMediaImages {
  return mapStaticImageSizes((size) => {
    const params = new URLSearchParams({
      size,
      pitch: "0",
      fov: "80",
      return_error_code: "true",
    });
    // Supplying the requested property location without pano or heading lets
    // Google select nearby coverage and auto-aim its camera at the property.
    params.set(
      "location",
      options.coordinates
        ? `${options.coordinates.lat},${options.coordinates.lon}`
        : options.completeAddress!,
    );
    params.set("radius", String(STREET_VIEW_METADATA_RADIUS_METERS));
    params.set("source", "outdoor");
    return buildSignedGoogleMapsUrl(
      STREET_VIEW_STATIC_BASE,
      params,
      options.staticKey,
      options.signingSecret,
    );
  });
}

function buildAerialImages(options: {
  coordinates: { lat: number; lon: number } | null;
  completeAddress: string | null;
  staticKey: string;
  signingSecret: string;
}): { images: LeadMediaImages; resolvedBy: "coordinates" | "address" } {
  const center = options.coordinates
    ? `${options.coordinates.lat},${options.coordinates.lon}`
    : options.completeAddress!;
  return {
    resolvedBy: options.coordinates ? "coordinates" : "address",
    images: mapStaticImageSizes((size) => {
      const params = new URLSearchParams({
        center,
        zoom: "19",
        size,
        scale: "2",
        maptype: "satellite",
      });
      return buildSignedGoogleMapsUrl(
        STATIC_MAP_BASE,
        params,
        options.staticKey,
        options.signingSecret,
      );
    }),
  };
}

function mapStaticImageSizes(
  build: (
    size: (typeof STATIC_IMAGE_SIZES)[keyof typeof STATIC_IMAGE_SIZES],
  ) => string,
): LeadMediaImages {
  return {
    small: build(STATIC_IMAGE_SIZES.small),
    mobile: build(STATIC_IMAGE_SIZES.mobile),
    smallTablet: build(STATIC_IMAGE_SIZES.smallTablet),
    tablet: build(STATIC_IMAGE_SIZES.tablet),
    desktop: build(STATIC_IMAGE_SIZES.desktop),
    wide: build(STATIC_IMAGE_SIZES.wide),
    large: build(STATIC_IMAGE_SIZES.large),
    extraLarge: build(STATIC_IMAGE_SIZES.extraLarge),
    ultra: build(STATIC_IMAGE_SIZES.ultra),
  };
}

function buildSignedGoogleMapsUrl(
  base: string,
  params: URLSearchParams,
  staticKey: string,
  signingSecret: string,
): string {
  const url = new URL(base);
  for (const [name, value] of params) url.searchParams.append(name, value);
  url.searchParams.set("key", staticKey);
  url.searchParams.set("signature", signGoogleMapsUrl(url, signingSecret));
  return url.toString();
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
  locationQuery: string,
  options: {
    metadataKey: string;
    signingSecret: string;
    fetcher: typeof fetch;
    cacheEnabled: boolean;
  },
): Promise<StreetViewMetadataResult> {
  const cacheKey = locationQuery.trim().toLowerCase();
  const cached = options.cacheEnabled ? metadataCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (cached) metadataCache.delete(cacheKey);

  const url = new URL(STREET_VIEW_METADATA_BASE);
  url.searchParams.set("location", locationQuery);
  url.searchParams.set("radius", String(STREET_VIEW_METADATA_RADIUS_METERS));
  url.searchParams.set("source", "outdoor");
  url.searchParams.set("key", options.metadataKey);
  url.searchParams.set(
    "signature",
    signGoogleMapsUrl(url, options.signingSecret),
  );

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
  const address = location.address?.trim() ?? "";
  const city = location.city?.trim() ?? "";
  const state = location.state?.trim().toUpperCase() ?? "";
  const zip = location.zip?.trim() ?? "";
  const structurallyValid =
    address.length > 0 &&
    address.length <= 160 &&
    /\d/.test(address) &&
    /\p{L}/u.test(address) &&
    city.length > 0 &&
    city.length <= 80 &&
    /\p{L}/u.test(city) &&
    /^[A-Z]{2}$/.test(state) &&
    /^\d{5}(?:-\d{4})?$/.test(zip);
  if (!structurallyValid) return null;
  return `${address}, ${city}, ${state} ${zip}`;
}
