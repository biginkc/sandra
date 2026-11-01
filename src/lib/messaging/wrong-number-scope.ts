/**
 * Wrong-number scope from the seller's own words (existing live text match, moved verbatim
 * from inbound.ts). "all" = a phone-wide claim ("wrong number", "nobody by that name").
 */
export function classifyWrongNumberScope(
  body: string,
): "this_property" | "all" {
  if (
    /\bwrong (?:number|person)\b/i.test(body) ||
    /\bnever (?:owned|own) (?:any )?propert(?:y|ies)\b/i.test(body) ||
    /\bnobody by that name\b/i.test(body) ||
    /\bno one by that name\b/i.test(body)
  ) {
    return "all";
  }
  return "this_property";
}
