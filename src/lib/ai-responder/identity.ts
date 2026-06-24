export const IDENTITY_REPLY_BODY =
  "I'm sorry I should have mentioned that. I'm Mel with BMH. We're local home buyers since 1998. Any chance you'd consider a cash offer on your property?";

const IDENTITY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bwho\s+(is|are|'?s|r)\s+(this|you|u|asking|texting|calling)\b/i,
  /\bwho'?s\s+(this|texting|calling|asking)\b/i,
  /\bwhos\s+(this|texting|calling|asking)\b/i,
  /\bwho\s+(are|r)\s+(you|u)\s+(with|representing|working\s+for)\b/i,
  /\bwhat\s+(company|business|organization)\b/i,
  /\bwho\s+am\s+i\s+(talking|speaking|texting)\s+(to|with)\b/i,
  /\bidentify\s+yourself\b/i,
];

export function isIdentityQuestion(body: string): boolean {
  const normalized = body.trim();
  if (!normalized) return false;
  return IDENTITY_PATTERNS.some((pattern) => pattern.test(normalized));
}
