import type { DisplayLine } from "./script-block";

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** Split spoken text for reading without splitting or rewriting token chips. */
export function splitDisplaySentences(line: DisplayLine): DisplayLine[] {
  if (line.type === "note") return [line];
  let offset = 0;
  const spans = line.segments.map((segment) => {
    const value = segment.kind === "text" ? segment.value : "\uFFFC";
    const span = { segment, start: offset, end: offset + value.length, value };
    offset = span.end;
    return span;
  });
  const text = spans.map((span) => span.value).join("");
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  for (const sentence of sentences.segment(text)) {
    const end = sentence.index + sentence.segment.length;
    // Keep the source's numbered outcomes attached to their sentence.
    if (!sentence.segment.trim() || /^\d+\.$/.test(sentence.segment.trim())) continue;
    ranges.push({ start, end });
    start = end;
  }
  if (!ranges.length) return [line];
  ranges[ranges.length - 1].end = text.length;
  return ranges.map(({ start, end }) => ({
    ...line,
    segments: spans.filter((span) => span.start < end && span.end > start).map((span) =>
      span.segment.kind === "text"
        ? { ...span.segment, value: span.value.slice(Math.max(start - span.start, 0), end - span.start) }
        : span.segment,
    ),
  }));
}
