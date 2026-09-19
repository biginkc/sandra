import { containerMime, extensionForMime } from './reliability-capture-format.mjs';

/**
 * Validate the complete event/chunk shape before an export can create files.
 * Event segment IDs are included so a trailing started/stopped segment with no
 * media cannot disappear just because it has no chunk rows.
 */
export function validateCaptureSegments(capture) {
  const segments = new Map();
  const segmentIds = new Set();
  for (const event of capture.events) {
    if (!Number.isSafeInteger(event.segment) || event.segment < 1)
      throw new Error('Invalid capture event metadata');
    segmentIds.add(event.segment);
  }
  for (const chunk of capture.chunks) {
    if (!Number.isSafeInteger(chunk.segment) || chunk.segment < 1 ||
        !Number.isSafeInteger(chunk.sequence) || chunk.sequence < 1 ||
        !Number.isSafeInteger(chunk.size) || chunk.size < 1) throw new Error('Invalid chunk metadata');
    const ext = extensionForMime(chunk.mimeType);
    if (!ext) throw new Error(`Unsupported capture MIME type: ${chunk.mimeType}`);
    const previous = segments.get(chunk.segment) ?? {
      next: 1, mimeType: chunk.mimeType, containerMime: containerMime(chunk.mimeType), ext,
      mimeTypes: new Set(), chunks: [],
    };
    previous.mimeTypes.add(chunk.mimeType);
    if (chunk.sequence !== previous.next || containerMime(chunk.mimeType) !== previous.containerMime)
      throw new Error(`Missing, duplicate, or inconsistent chunk in segment ${chunk.segment}`);
    previous.next += 1;
    previous.chunks.push(chunk);
    segments.set(chunk.segment, previous);
    segmentIds.add(chunk.segment);
  }
  const orderedSegmentIds = [...segmentIds].sort((left, right) => left - right);
  if (orderedSegmentIds.some((segment, index) => segment !== index + 1))
    throw new Error('Missing or noncontiguous capture segment');
  for (const segment of orderedSegmentIds) {
    const info = segments.get(segment);
    if (!info?.chunks.length) throw new Error(`Segment ${segment} has no media chunks`);
    const events = capture.events.filter((event) => event.segment === segment);
    if (events[0]?.kind !== 'started' || events.at(-1)?.kind !== 'stopped' ||
        events.filter((event) => event.kind === 'started').length !== 1 ||
        events.filter((event) => event.kind === 'stopped').length !== 1 ||
        events[0].atMonotonicMs > events.at(-1).atMonotonicMs)
      throw new Error(`Segment ${segment} has no ordered start/stop evidence`);
    if (events.filter((event) => event.kind === 'chunk').length !== info.chunks.length)
      throw new Error(`Segment ${segment} has mismatched chunk events`);
  }
  return segments;
}
