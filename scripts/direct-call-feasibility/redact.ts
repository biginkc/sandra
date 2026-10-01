 
// Redaction helpers: Authorization, API key, bearer tokens, phone numbers.

export function redactText(input: string, secrets: string[] = []): string {
  let out = input;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  out = out.replace(/\bKEY[A-Z0-9_]{16,}\b/g, "[REDACTED]");
  out = out.replace(/\+\d{7,15}/g, (m) => `+***${m.slice(-4)}`);
  return out;
}

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = /^(authorization|x-api-key)$/i.test(k) ? "[REDACTED]" : v;
  }
  return out;
}
