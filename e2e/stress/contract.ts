import { randomUUID } from "node:crypto";

import { esignRequestFixture } from "../../tests/integration/fixtures/esign";
import { asRep, asService, errCode } from "./db";
import type { Ctx } from "./actions";
import { sleep } from "./actions";
import type { WorldLead } from "./world";

/**
 * Contract send, modelled step by step the way the send action orders it:
 *   1. projection (fn_create_offer_projection)  - refuses a second open contract (OPEN_CONTRACT_EXISTS)
 *   2. request row (unique per send intent)     - the loser of a double click gets 23505 and NEVER calls the provider
 *   3. provider send (Dropbox Sign stub, seam S3)
 *   4. mark sent + project the offer (only after `sent`)
 * A lost response leaves the row `send_unknown`; it is reconciled from the provider's record and is never resent.
 */

export type ContractResult = {
  ok: boolean;
  code?: string;
  duplicate?: boolean;
  intent: string;
  projectionId?: string;
  requestId?: string;
  state: "sent" | "send_unknown" | "rejected" | "duplicate" | "refused";
  offerId?: string | null;
};

const PRICE = "$250,000.00";
const PRICE_CENTS = 25_000_000;

export async function contractSend(
  ctx: Ctx,
  lead: WorldLead,
  opts: { intent?: string; requestHash?: string; /** abort the caller after the provider recorded the request (lost response) */ loseResponse?: boolean; gateStub?: boolean } = {},
): Promise<ContractResult> {
  const intent = opts.intent ?? randomUUID();
  const closing = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  let projectionId: string;
  try {
    const r = await asService(ctx.db, (c) =>
      c.query<{ id: string }>("select public.fn_create_offer_projection($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::date,'no_motivation',null,null) as id", [
        ctx.cfg.orgId, lead.propertyId, ctx.world.repUserId, intent, opts.requestHash ?? `h-${intent}`, "s1", JSON.stringify({ offer_price: PRICE }), PRICE_CENTS, closing,
      ]),
    );
    projectionId = r.rows[0]!.id;
  } catch (e) {
    return { ok: false, code: errCode(e), intent, state: "refused" };
  }

  const fx = esignRequestFixture({ orgId: ctx.cfg.orgId, propertyId: lead.propertyId, templateId: ctx.world.templateId, userId: ctx.world.repUserId, sendIntentId: intent });
  fx.merge_value_snapshot = { ...fx.merge_value_snapshot, offer_price: PRICE } as typeof fx.merge_value_snapshot;
  try {
    await ctx.db.query(
      `insert into public.esign_requests (id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,send_intent_id,payload_hash,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [fx.id, ctx.cfg.orgId, lead.propertyId, ctx.world.templateId, JSON.stringify(fx.signer_snapshot), JSON.stringify(fx.merge_value_snapshot), intent, fx.payload_hash, ctx.world.repUserId],
    );
  } catch (e) {
    if (errCode(e) === "23505") return { ok: true, duplicate: true, intent, projectionId, state: "duplicate" };
    return { ok: false, code: errCode(e), intent, projectionId, state: "refused" };
  }

  const url = `${ctx.stub.url}/dropbox-sign/v3/signature_request/send_with_template`;
  const body = JSON.stringify({ key: fx.id, client_key: intent, property: lead.propertyId });
  const post = (signal?: AbortSignal) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal });
  let signRequestId: string | null = null;
  if (opts.loseResponse) {
    const ac = new AbortController();
    const p = post(ac.signal).then((r) => r.json() as Promise<{ signature_request?: { signature_request_id?: string } }>).catch(() => null);
    // The request has reached the provider once its stub log has the key; then the caller loses the response.
    for (let i = 0; i < 200 && !ctx.stub.sends().some((s) => s.key === fx.id); i += 1) await sleep(10);
    ac.abort();
    await p;
  } else {
    const res = await post();
    if (res.ok) signRequestId = ((await res.json()) as { signature_request?: { signature_request_id?: string } }).signature_request?.signature_request_id ?? null;
  }
  if (ctx.faults.take("duplicate_send")) await post().catch(() => null); // injected defect: the same contract sent twice

  if (!signRequestId) {
    await ctx.db.query("update public.esign_requests set delivery_state='send_unknown', delivery_state_entered_at=now() where id=$1 and delivery_state='sending'", [fx.id]);
    return { ok: true, intent, projectionId, requestId: fx.id, state: "send_unknown" };
  }
  const offerId = await markSentAndProject(ctx, fx.id, projectionId, signRequestId);
  return { ok: true, intent, projectionId, requestId: fx.id, state: "sent", offerId };
}

export async function markSentAndProject(ctx: Ctx, requestId: string, projectionId: string, signRequestId: string): Promise<string | null> {
  await ctx.db.query("update public.esign_requests set delivery_state='sent', sign_request_id=$2, sent_at=now(), delivery_state_entered_at=now() where id=$1", [requestId, signRequestId]);
  if (ctx.faults.take("drop_offer")) {
    // injected defect: the offer is dropped (the request is voided before projection, so no sweep can recover it)
    await ctx.db.query("update public.esign_requests set void_requested_at=now() where id=$1", [requestId]);
  }
  const r = await asService(ctx.db, (c) => c.query<{ r: { state: string; offerId?: string } }>("select public.fn_project_acquisition_offer($1) as r", [projectionId]));
  return r.rows[0]!.r.offerId ?? null;
}

/** Reconcile a `send_unknown` row from the provider's own record (the stub log). Never calls the provider again. */
export async function reconcileSendUnknown(ctx: Ctx, result: ContractResult): Promise<"recovered" | "still_unknown"> {
  if (!result.requestId || !result.projectionId) return "still_unknown";
  const rec = ctx.stub.sends().find((s) => s.key === result.requestId);
  if (!rec) return "still_unknown";
  await markSentAndProject(ctx, result.requestId, result.projectionId, `sr_recon_${result.requestId.slice(0, 8)}`);
  return "recovered";
}

/** Supersede recovery (D8): a stale pending offer exists when the contract's projection runs. */
export async function logStalePendingOffer(ctx: Ctx, lead: WorldLead, hoursAgo = 3): Promise<string> {
  const ep = await ctx.db.query<{ id: string }>("select id from public.acquisition_assignment_episodes where property_id=$1 and ended_at is null", [lead.propertyId]);
  // acquisition_queue_states is closed to the member's role; read the version and status as the owner connection.
  const ctxRow = (await ctx.db.query<{ v: string; status: string }>("select coalesce((select version from public.acquisition_queue_states where property_id=$1),0)::text as v, (select status from public.properties where id=$1) as status", [lead.propertyId])).rows[0]!;
  const r = await asRep(ctx.db, ctx.world.repUserId, (c) =>
    c.query<{ r: { offerId: string } }>("select public.fn_log_acquisition_offer($1,$2,$3,$4::bigint,$5,$6,150000,'verbal',$7,$8,'no_motivation',null,null) as r", [
      ctx.cfg.orgId, lead.propertyId, ep.rows[0]!.id, ctxRow.v, ctxRow.status, randomUUID(), new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString(),
    ]),
  );
  return r.rows[0]!.r.offerId;
}

export async function supersedeAndLog(ctx: Ctx, projectionId: string): Promise<{ ok: boolean; code?: string }> {
  try {
    await asRep(ctx.db, ctx.world.repUserId, (c) => c.query("select public.fn_supersede_offer_and_log($1,$2,$3)", [ctx.cfg.orgId, projectionId, randomUUID()]));
    return { ok: true };
  } catch (e) {
    return { ok: false, code: errCode(e) };
  }
}
