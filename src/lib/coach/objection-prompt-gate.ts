import "server-only";

export function isObjectionPromptAllowed(userId: string, enabled: string | undefined, allowlist: string | undefined): boolean {
  return enabled === "1" && Boolean(userId) && (allowlist ?? "").split(",").some((id) => id.trim() === userId);
}
