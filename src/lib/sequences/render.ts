/**
 * Re-export from shared templates library.
 * Kept for backwards compatibility — all sequence code can continue
 * importing from `./render` without changes.
 *
 * @see src/lib/templates/render.ts for the canonical implementation.
 */
export { renderTemplate, type TemplateVars } from "@/lib/templates/render";
