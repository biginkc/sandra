/**
 * Campaign queue RPCs (pause / resume / apply cadence) process at most
 * `p_limit` messages per call and report `remaining_count`, so no single
 * statement approaches production's 8s statement_timeout. These helpers loop
 * until the RPC reports nothing remaining.
 *
 * Until the batching migration is applied, the RPC only exists with its old
 * argument list; PostgREST then answers PGRST202 for the new arguments and
 * we fall back to the old single-shot call (identical to the pre-batching
 * behaviour).
 */

export const CAMPAIGN_QUEUE_BATCH_LIMIT = 100;
export const CAMPAIGN_QUEUE_MAX_BATCHES = 600;

type RpcError = { message: string; code?: string } | null;

export type CampaignQueueRpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError }>;
};

type CadenceRow = {
  affected_count: number | string | null;
  first_scheduled_for: string | null;
  last_scheduled_for: string | null;
  remaining_count?: number | string | null;
};

type PauseRow = {
  affected_count: number | string | null;
  pending_count: number | string | null;
  paused_count: number | string | null;
  remaining_count?: number | string | null;
};

export type BatchedCadenceTotals = {
  affected_count: number;
  first_scheduled_for: string | null;
  last_scheduled_for: string | null;
};

export type BatchedPauseTotals = {
  affected_count: number;
  pending_count: number;
  paused_count: number;
};

export type BatchedResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; batchesCompleted: number };

function isMissingSignature(error: RpcError): boolean {
  return error?.code === "PGRST202";
}

function firstRow<T>(data: unknown): T | undefined {
  return Array.isArray(data) ? (data[0] as T | undefined) : undefined;
}

function partialMessage(message: string, batches: number): string {
  if (batches === 0) return message;
  return `${message} (${batches} batch${batches === 1 ? "" : "es"} already applied; retry to finish the rest)`;
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export async function runBatchedCadenceRpc(
  client: CampaignQueueRpcClient,
  fn: "resume_campaign_queue" | "apply_campaign_cadence_reschedule",
  baseArgs: Record<string, unknown>,
  options: { limit?: number; maxBatches?: number } = {},
): Promise<BatchedResult<BatchedCadenceTotals>> {
  const limit = options.limit ?? CAMPAIGN_QUEUE_BATCH_LIMIT;
  const maxBatches = options.maxBatches ?? CAMPAIGN_QUEUE_MAX_BATCHES;
  const batchArgs: Record<string, unknown> = { ...baseArgs, p_limit: limit };
  if (fn === "apply_campaign_cadence_reschedule") {
    batchArgs.p_run_id = globalThis.crypto.randomUUID();
  }

  const totals: BatchedCadenceTotals = {
    affected_count: 0,
    first_scheduled_for: null,
    last_scheduled_for: null,
  };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const { data, error } = await client.rpc(fn, batchArgs);
    if (error) {
      if (batch === 0 && isMissingSignature(error)) {
        const legacy = await client.rpc(fn, baseArgs);
        if (legacy.error) {
          return { ok: false, message: legacy.error.message, batchesCompleted: 0 };
        }
        const row = firstRow<CadenceRow>(legacy.data);
        return {
          ok: true,
          data: {
            affected_count: Number(row?.affected_count ?? 0),
            first_scheduled_for: row?.first_scheduled_for ?? null,
            last_scheduled_for: row?.last_scheduled_for ?? null,
          },
        };
      }
      return {
        ok: false,
        message: partialMessage(error.message, batch),
        batchesCompleted: batch,
      };
    }

    const row = firstRow<CadenceRow>(data);
    totals.affected_count += Number(row?.affected_count ?? 0);
    totals.first_scheduled_for = earliest(
      totals.first_scheduled_for,
      row?.first_scheduled_for ?? null,
    );
    totals.last_scheduled_for = latest(
      totals.last_scheduled_for,
      row?.last_scheduled_for ?? null,
    );
    if (Number(row?.remaining_count ?? 0) <= 0) {
      return { ok: true, data: totals };
    }
  }

  return {
    ok: false,
    message: partialMessage(
      `Campaign still had messages left after ${maxBatches} batches`,
      maxBatches,
    ),
    batchesCompleted: maxBatches,
  };
}

export async function runBatchedPauseRpc(
  client: CampaignQueueRpcClient,
  baseArgs: Record<string, unknown>,
  options: { limit?: number; maxBatches?: number } = {},
): Promise<BatchedResult<BatchedPauseTotals>> {
  const limit = options.limit ?? CAMPAIGN_QUEUE_BATCH_LIMIT;
  const maxBatches = options.maxBatches ?? CAMPAIGN_QUEUE_MAX_BATCHES;
  const totals: BatchedPauseTotals = {
    affected_count: 0,
    pending_count: 0,
    paused_count: 0,
  };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const { data, error } = await client.rpc("pause_campaign_queue", {
      ...baseArgs,
      p_limit: limit,
    });
    if (error) {
      if (batch === 0 && isMissingSignature(error)) {
        const legacy = await client.rpc("pause_campaign_queue", baseArgs);
        if (legacy.error) {
          return { ok: false, message: legacy.error.message, batchesCompleted: 0 };
        }
        const row = firstRow<PauseRow>(legacy.data);
        return {
          ok: true,
          data: {
            affected_count: Number(row?.affected_count ?? 0),
            pending_count: Number(row?.pending_count ?? 0),
            paused_count: Number(row?.paused_count ?? 0),
          },
        };
      }
      return {
        ok: false,
        message: partialMessage(error.message, batch),
        batchesCompleted: batch,
      };
    }

    const row = firstRow<PauseRow>(data);
    totals.affected_count += Number(row?.affected_count ?? 0);
    totals.pending_count = Number(row?.pending_count ?? 0);
    totals.paused_count = Number(row?.paused_count ?? 0);
    if (Number(row?.remaining_count ?? 0) <= 0) {
      return { ok: true, data: totals };
    }
  }

  return {
    ok: false,
    message: partialMessage(
      `Campaign still had queued messages after ${maxBatches} batches`,
      maxBatches,
    ),
    batchesCompleted: maxBatches,
  };
}
