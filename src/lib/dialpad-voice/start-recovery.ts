import "server-only";

export type PredispatchRecoveryClient = {
  rpc(name: "fn_recover_dialpad_pre_dispatch", args: { p_org_id: string; p_limit: number }): PromiseLike<{ data: unknown; error: unknown }>;
};

/** Abandons only old, atomically proven undispatched reservations. This never
 * retries a provider call or releases a dispatched/ambiguous reservation.
 * Scheduling belongs to the worker; constructing this function performs no IO.
 */
export async function recoverDialpadPredispatch(client: PredispatchRecoveryClient, orgId: string, limit = 20): Promise<{ recovered: number; resumed: number }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid Dialpad recovery scope");
  try {
    const result = await client.rpc("fn_recover_dialpad_pre_dispatch", { p_org_id: orgId, p_limit: limit });
    if (result.error || !result.data || typeof result.data !== "object") throw new Error();
    const data = result.data as Record<string, unknown>;
    if (typeof data.recovered !== "number" || !Number.isSafeInteger(data.recovered) || data.recovered < 0 || data.recovered > limit || typeof data.resumed !== "number" || !Number.isSafeInteger(data.resumed) || data.resumed < 0) throw new Error();
    return { recovered: data.recovered, resumed: data.resumed };
  } catch {
    throw new Error("Dialpad predispatch recovery was not confirmed");
  }
}
