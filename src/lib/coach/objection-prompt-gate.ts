import "server-only";

export function isObjectionPromptAllowed(enabled: string | undefined): boolean {
  return enabled === "1";
}
