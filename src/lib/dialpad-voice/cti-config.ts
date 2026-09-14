import "server-only";

/** Only public embed configuration crosses into the browser. The feature stays
 * disabled until Dialpad provisions the client and approves the parent origin.
 */
export function mariaCtiConfig(viewer: { orgId: string; userId: string } | null) {
  if (process.env.DIALPAD_CTI_ENABLED !== "true" || !viewer ||
    viewer.orgId !== "00000000-0000-0000-0000-000000000bbb" ||
    viewer.orgId !== process.env.DIALPAD_VOICE_ORG_ID ||
    viewer.userId !== process.env.DIALPAD_VOICE_SANDRA_USER_ID ||
    process.env.DIALPAD_VOICE_USER_ID !== "4904023124647936") return null;
  const clientId = process.env.DIALPAD_CTI_CLIENT_ID;
  if (!clientId || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) return null;
  return { clientId, expectedUserId: "4904023124647936" };
}
