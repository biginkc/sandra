/**
 * One-shot setup route — registers the Dialpad inbound-SMS webhook.
 * DELETE THIS FILE immediately after use.
 *
 * Token: dp-setup-x4k7n2-2026-05-04
 */

import { NextResponse } from "next/server";

const ONE_TIME_TOKEN = "dp-setup-x4k7n2-2026-05-04";
const API_BASE = "https://dialpad.com/api/v2";
const HOOK_URL = "https://sandra-sooty.vercel.app/api/webhooks/dialpad/sms";

export async function POST(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${ONE_TIME_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.DIALPAD_API_KEY;
  const webhookSecret = process.env.DIALPAD_WEBHOOK_SECRET;
  if (!apiKey || !webhookSecret) {
    return NextResponse.json(
      { error: "DIALPAD_API_KEY or DIALPAD_WEBHOOK_SECRET not set" },
      { status: 500 },
    );
  }

  // Step 1: Create the webhook
  const webhookRes = await fetch(`${API_BASE}/webhooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ hook_url: HOOK_URL, secret: webhookSecret }),
  });
  const webhookText = await webhookRes.text();
  let webhookBody: unknown;
  try {
    webhookBody = JSON.parse(webhookText);
  } catch {
    webhookBody = webhookText;
  }

  if (!webhookRes.ok) {
    return NextResponse.json(
      { step: "create_webhook", status: webhookRes.status, body: webhookBody },
      { status: 502 },
    );
  }

  const webhookId =
    webhookBody &&
    typeof webhookBody === "object" &&
    "id" in (webhookBody as object)
      ? (webhookBody as Record<string, unknown>).id
      : null;

  if (!webhookId) {
    return NextResponse.json(
      {
        step: "create_webhook",
        error: "no id in response",
        body: webhookBody,
      },
      { status: 502 },
    );
  }

  // Step 2: Subscribe to inbound SMS events
  const subRes = await fetch(`${API_BASE}/subscriptions/sms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ direction: "inbound", endpoint_id: webhookId }),
  });
  const subText = await subRes.text();
  let subBody: unknown;
  try {
    subBody = JSON.parse(subText);
  } catch {
    subBody = subText;
  }

  return NextResponse.json({
    webhook: { status: webhookRes.status, body: webhookBody },
    subscription: { status: subRes.status, body: subBody },
    ok: webhookRes.ok && subRes.ok,
  });
}
