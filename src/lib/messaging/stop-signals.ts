/**
 * Inbound opt-out / do-not-contact wording detectors, moved VERBATIM out of
 * inbound.ts so other modules (the Luna suggestion gate) can reuse the exact
 * same lists without importing the webhook module (which would create an
 * import cycle through the AI responder). No pattern text was changed.
 */

const UNAMBIGUOUS_STOP_KEYWORDS =
  /\b(?:stopall|unsubscribe|opt(?:\s|-)?out|remove me|take me off|delete my (?:number|info)|leave me alone|quit bothering me|do not contact me|don'?t text me again|lose (?:this|my) number|never contact me)\b|\bstop\b(?!\s+by\b)/i;
const AMBIGUOUS_STOP_KEYWORDS = /^\s*(end|cancel|quit|remove)\s*$/i;
export const DNC_KEYWORDS =
  /do not (call|text|contact|reach out|message)|don'?t (call|text|contact|reach out|message)|stop (texting|calling|contacting) me|take me off|no more (texts|messages|calls)|remove me from|stop reaching out|please delete my (number|info)|delete my (number|info)|lose (this|my) number|never contact me/i;

export function matchesStopKeyword(body: string) {
  return (
    UNAMBIGUOUS_STOP_KEYWORDS.test(body) || AMBIGUOUS_STOP_KEYWORDS.test(body)
  );
}

export function matchesDncKeyword(body: string) {
  return DNC_KEYWORDS.test(body);
}
