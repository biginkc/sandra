/**
 * Word lists for the redactor (code constants, not business rules). Both lists only RELAX single-token
 * masking; a whole name (two or more tokens, e.g. "Bob Price") is always masked, whatever its words.
 */

/** Never masked as a single token (they are role/structure words), only inside a whole name. */
export const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "speaker", "unknown", "caller", "rep", "llc", "inc", "trust", "estate", "family", "the", "and", "of",
  "info", "sales", "admin", "office", "team", "support", "other", "party", "seller", "buyer", "owner",
  "homeowner", "lead", "operator", "agent", "customer", "user", "company", "corp", "group", "properties",
  "realty", "holdings", "investments", "enterprises", "partners", "associates", "services", "mr", "mrs", "ms",
]);

/**
 * English words that are also common first names or surnames. Masked as a single token ONLY when
 * Capitalized in the text, so "Mr Price" is masked and "a good price" is not. Two-letter names get the
 * same treatment (see redact.ts).
 */
export const COMMON_WORD_NAMES: ReadonlySet<string> = new Set([
  "will", "hope", "grant", "mark", "bill", "rich", "rose", "faith", "joy", "frank", "dawn", "summer", "price",
  "young", "king", "rice", "case", "hunter", "cash", "may", "june", "april", "august", "ray", "guy", "art",
  "bob", "sky", "chase", "lane", "wood", "brown", "white", "green", "black", "gray", "grey", "hill", "field",
  "fields", "ford", "bell", "bird", "bishop", "blake", "bond", "brooks", "buck", "carter", "cook", "cross",
  "dale", "day", "dean", "drew", "earl", "east", "fair", "fish", "fox", "gold", "hall", "hart", "hay",
  "heath", "hood", "hope", "jack", "jay", "jean", "jordan", "knight", "lake", "lee", "long", "love", "major",
  "mason", "mills", "moon", "moore", "morgan", "page", "park", "pat", "pearl", "penny", "pierce", "porter",
  "rain", "reed", "reeves", "rich", "river", "rob", "rock", "ross", "rush", "sage", "sands", "sharp", "shaw",
  "skip", "smart", "snow", "stone", "storm", "swift", "taylor", "temple", "tiger", "ward", "warren",
  "waters", "west", "wells", "old", "wild", "wise", "wolf", "woods", "wright", "bay", "bass", "bent", "best", "bright",
  "carol", "chance", "charity", "chip", "clay", "cliff", "colt", "daisy", "dale", "ever", "flint", "forest",
  "glen", "grace", "heather", "holly", "ivy", "jewel", "kim", "lily", "mercy", "miles", "neal", "noble", "pace",
  "patience", "peace", "river", "robin", "ruby", "sandy", "sterling", "trinity", "victor", "violet", "walker",
  "wade", "will", "wilson", "winter", "forest", "hunt", "hunter", "mann", "monk", "nash", "payne", "plant",
  "poole", "pound", "prince", "pride", "rider", "sheen", "sims", "slate", "steel", "strong", "sweet", "tate",
  "thorn", "tracy", "trout", "tucker", "vance", "vine", "wall", "webb", "weeks", "wheeler", "wing", "yates",
]);
