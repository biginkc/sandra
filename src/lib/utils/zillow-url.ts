/**
 * Build a Zillow search-redirect URL from a property address.
 *
 * Zillow's `/homes/{slug}_rb/` URL format is a free, no-API redirect:
 * the page resolves to the matching property page when Zillow has it,
 * or to a search results list otherwise. No key, no quota, no cost.
 *
 * Format reference: https://www.zillow.com/homes/{slugified-address}_rb/
 *
 * Caller passes whichever of address/city/state/zip is available.
 * Empty + null parts are dropped before slugifying so the URL stays
 * clean even when zip or city is missing.
 */
export function zillowUrl(parts: {
  address: string | null | undefined;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string | null {
  const pieces = [parts.address, parts.city, parts.state, parts.zip]
    .map((p) => (p ?? "").toString().trim())
    .filter((p) => p.length > 0);
  if (pieces.length === 0 || !parts.address?.trim()) return null;

  const slug = pieces
    .join(" ")
    // Keep alphanumeric, whitespace, and hyphen (e.g. "12-34 Main St").
    .replace(/[^a-z0-9\s-]/gi, "")
    // Whitespace → hyphen
    .replace(/\s+/g, "-")
    // Collapse runs of hyphens that result from punctuation removal
    .replace(/-+/g, "-")
    // Trim leading / trailing hyphens
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) return null;

  return `https://www.zillow.com/homes/${slug}_rb/`;
}
