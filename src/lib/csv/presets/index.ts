/**
 * Vendor-format preset registry + dispatcher.
 *
 * Detection rule: each preset's `detect()` returns `{ confidence }` in
 * 0..1. We pick the highest-scoring result iff:
 *   1. its confidence ≥ `MIN_CONFIDENCE` (0.7), AND
 *   2. it beats the runner-up by ≥ `MARGIN` (0.2).
 *
 * Otherwise we return null and the wizard's banner stays hidden — the
 * user can still open the format-helper dialog manually from the upload
 * step. Tied / ambiguous shapes are deliberately treated as "no match"
 * to keep the auto-apply behavior trustworthy.
 */
import { propstreamPreset } from "./propstream";
import { titleproPreset } from "./titlepro";
import { reisiftPreset } from "./reisift";
import { bmhAgentOutreachPreset } from "./bmh-agent-outreach";
import { permitsPreset } from "./permits";
import { cnamPreset } from "./cnam";
import type { DetectionResult, VendorPreset, VendorPresetId } from "./types";

export const PRESETS: readonly VendorPreset[] = [
  propstreamPreset,
  titleproPreset,
  reisiftPreset,
  bmhAgentOutreachPreset,
  permitsPreset,
  cnamPreset,
];

export const MIN_CONFIDENCE = 0.7;
export const MARGIN = 0.2;

/**
 * Run every preset's `detect()` and return the best-scoring match,
 * subject to the threshold + margin rules above. Pure function.
 *
 * Sample rows: pass first ~20 rows of the parsed CSV. Some presets
 * (TitlePro subtype detection, REISift "DNC Excluded" sentinel) need
 * row content beyond headers; others ignore sampleRows entirely.
 */
export function detectVendor(
  headers: readonly string[],
  sampleRows: readonly Record<string, string>[],
): DetectionResult | null {
  if (headers.length === 0) return null;

  const results: DetectionResult[] = [];
  for (const preset of PRESETS) {
    const result = preset.detect(headers, sampleRows);
    if (result && result.confidence > 0) {
      results.push(result);
    }
  }

  if (results.length === 0) return null;

  // Sort descending by confidence.
  results.sort((a, b) => b.confidence - a.confidence);
  const top = results[0];
  const runnerUp = results[1];

  if (top.confidence < MIN_CONFIDENCE) return null;
  if (runnerUp && top.confidence - runnerUp.confidence < MARGIN) {
    // Tied within margin — refuse to guess. User can pick manually
    // from the helper dialog.
    return null;
  }

  return top;
}

/**
 * Look up a preset by id. Throws if id isn't registered — fail-fast in
 * dev rather than silently dropping a transform on prod.
 */
export function getPresetById(id: VendorPresetId): VendorPreset {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`Unknown vendor preset id: ${id}`);
  }
  return preset;
}
