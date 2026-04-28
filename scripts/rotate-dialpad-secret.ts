#!/usr/bin/env tsx
/**
 * Rotate Sandra's Dialpad SMS-subscription signing secret.
 *
 *   1. Lists every SMS subscription on the Dialpad account.
 *   2. Finds the one whose webhook hook_url points at Sandra's prod
 *      inbound endpoint (sandra-sooty.vercel.app/api/webhooks/dialpad/sms).
 *   3. PATCHes that subscription with the new signature.
 *   4. Prints success or a clear failure.
 *
 * Two inputs, both via env vars (NEVER hardcoded — secrets in source
 * files end up in git history and shared compromise blast radius):
 *   DIALPAD_API_KEY      — your bearer token from the Dialpad docs UI
 *                          or 1Password.
 *   NEW_WEBHOOK_SECRET   — the value to install everywhere.
 *
 * Generate one fresh with:  openssl rand -hex 32
 *
 * Usage (zsh: leading space keeps it out of HISTFILE if HIST_IGNORE_SPACE
 * is set; otherwise rotate the values again afterward):
 *    DIALPAD_API_KEY='your-token' NEW_WEBHOOK_SECRET='your-new-secret' \
 *      npx tsx scripts/rotate-dialpad-secret.ts
 *
 * Exits 0 on success, 1 on any failure.
 */

// Match by path — the host varies (sandra-sooty.vercel.app and the
// team-namespaced sandra-jarrad-5416s-projects.vercel.app both route to
// the same deployment). Path-only match catches whichever Dialpad has.
const PROD_HOOK_URL_FRAGMENT = "/api/webhooks/dialpad/sms";
const DIALPAD_BASE = "https://dialpad.com/api/v2";

async function main(): Promise<void> {
  const apiKey = process.env.DIALPAD_API_KEY;
  if (!apiKey) {
    console.error(
      "DIALPAD_API_KEY missing. Run with:\n" +
        "  DIALPAD_API_KEY='your-token' NEW_WEBHOOK_SECRET='your-new-secret' \\\n" +
        "    npx tsx scripts/rotate-dialpad-secret.ts",
    );
    process.exit(2);
  }
  const newSecret = process.env.NEW_WEBHOOK_SECRET;
  if (!newSecret) {
    console.error(
      "NEW_WEBHOOK_SECRET missing. Pass the new secret via env so it's never " +
        "checked in or recorded in shell history beyond this one invocation.",
    );
    process.exit(2);
  }

  // ---- Step 1: list SMS subscriptions ------------------------------------
  const listRes = await fetch(`${DIALPAD_BASE}/subscriptions/sms`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!listRes.ok) {
    console.error(
      `List subscriptions failed: ${listRes.status} ${await listRes.text()}`,
    );
    process.exit(1);
  }
  const listBody = (await listRes.json()) as {
    items?: Array<Record<string, unknown>>;
  };
  const subs = listBody.items ?? [];
  if (subs.length === 0) {
    console.error(
      "No SMS subscriptions found on this Dialpad account. " +
        "Was the inbound webhook ever configured? Check the Dialpad admin.",
    );
    process.exit(1);
  }

  // ---- Step 2: identify Sandra's subscription ----------------------------
  // The subscription's `hook_url` field (sometimes nested under `webhook`)
  // tells us where Dialpad delivers events. We match the prod-URL fragment.
  function urlOf(sub: Record<string, unknown>): string | null {
    if (typeof sub.hook_url === "string") return sub.hook_url;
    const hook = sub.webhook as Record<string, unknown> | undefined;
    if (hook && typeof hook.hook_url === "string") return hook.hook_url;
    return null;
  }
  const matches = subs.filter((s) =>
    (urlOf(s) ?? "").includes(PROD_HOOK_URL_FRAGMENT),
  );
  if (matches.length === 0) {
    console.error(
      `No subscription points at ${PROD_HOOK_URL_FRAGMENT}.\n` +
        `Found these subscription URLs:\n` +
        subs.map((s) => `  - ${urlOf(s) ?? "(no url)"}  id=${s.id}`).join("\n"),
    );
    process.exit(1);
  }
  if (matches.length > 1) {
    console.warn(
      `Multiple subscriptions point at the prod URL — updating ALL of them ` +
        `(${matches.length} subscriptions).`,
    );
  }

  // ---- Step 3: PATCH each match ------------------------------------------
  for (const sub of matches) {
    const id = sub.id;
    const patchRes = await fetch(`${DIALPAD_BASE}/subscriptions/sms/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        signature: { type: "hmac", secret: newSecret, algo: "HS256" },
      }),
    });
    if (!patchRes.ok) {
      console.error(
        `PATCH subscription ${id} failed: ${patchRes.status} ${await patchRes.text()}`,
      );
      process.exit(1);
    }
    console.log(`✓ Updated subscription ${id}`);
  }

  console.log("");
  console.log("Done. Next:");
  console.log(
    "  - Set the same value as PROD_DIALPAD_WEBHOOK_SECRET in GitHub repo secrets",
  );
  console.log(
    "  - (Already done if you already updated Vercel and triggered a redeploy.)",
  );
}

main().catch((err) => {
  console.error("Rotation FAILED:", err);
  process.exit(1);
});
