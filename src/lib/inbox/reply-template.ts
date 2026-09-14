import type { TemplateVars } from "@/lib/templates/render";

const VARIABLES = new Set(["first_name", "last_name", "property_address", "city", "state", "property_zip", "market", "my_first_name", "company_name"]);
type Node = { kind: "text"; value: string } | { kind: "variable"; name: string; fallback?: string } | { kind: "if"; name: string; children: Node[] };
export class ReplyTemplateError extends Error {
  constructor(readonly code: "invalid_template" | "unknown_variable" | "missing_variable" | "invalid_body", readonly variable?: string) { super(code); }
}
function variable(name: string): string {
  if (!VARIABLES.has(name)) throw new ReplyTemplateError("unknown_variable", name);
  return name;
}
/** Strict bulk-review boundary. Values are data, never reparsed as template
 * syntax. Existing Outbox rendering is untouched. Unsupported/malformed tokens
 * cannot silently become a seller-facing message. */
export function renderReviewedReply(template: string, vars: TemplateVars): string {
  if (typeof template !== "string" || !template.trim() || template.length > 1600) throw new ReplyTemplateError("invalid_body");
  const root: Node[] = [];
  let current = root, open: Extract<Node, { kind: "if" }> | undefined;
  let position = 0;
  while (position < template.length) {
    const start = template.indexOf("{{", position);
    const text = template.slice(position, start < 0 ? template.length : start);
    if (text.includes("}}")) throw new ReplyTemplateError("invalid_template");
    current.push({ kind: "text", value: text });
    if (start < 0) break;
    const end = template.indexOf("}}", start + 2);
    if (end < 0) throw new ReplyTemplateError("invalid_template");
    const token = template.slice(start + 2, end).trim();
    const condition = /^#if\s+([a-zA-Z_]\w*)$/.exec(token);
    const substitution = /^([a-zA-Z_]\w*)(?:\s*\|\s*([^{}]*))?$/.exec(token);
    if (condition) {
      if (open) throw new ReplyTemplateError("invalid_template");
      open = { kind: "if", name: variable(condition[1]), children: [] };
      root.push(open); current = open.children;
    } else if (token === "/if") {
      if (!open) throw new ReplyTemplateError("invalid_template");
      open = undefined; current = root;
    } else if (substitution) {
      current.push({ kind: "variable", name: variable(substitution[1]), ...(substitution[2] === undefined ? {} : { fallback: substitution[2].trim() }) });
    } else throw new ReplyTemplateError("invalid_template");
    position = end + 2;
  }
  if (open) throw new ReplyTemplateError("invalid_template");
  const read = (name: string) => Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
  function render(nodes: Node[]): string {
    return nodes.map(node => {
      if (node.kind === "text") return node.value;
      const value = read(node.name);
      if (value !== null && value !== undefined && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) throw new ReplyTemplateError("invalid_body");
      const missing = value === null || value === undefined || (typeof value === "string" && !value.trim());
      if (node.kind === "if") return missing || value === 0 ? "" : render(node.children);
      if (missing) {
        if (node.fallback !== undefined && node.fallback.length > 0) return node.fallback;
        throw new ReplyTemplateError("missing_variable", node.name);
      }
      return String(value);
    }).join("");
  }
  const body = render(root);
  if (!body.trim() || body.length > 1600) throw new ReplyTemplateError("invalid_body");
  return body;
}
