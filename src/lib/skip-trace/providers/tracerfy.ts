import {
  ConfigurationError,
  ProviderError,
  ValidationError,
} from "@/lib/errors/classes";

import type {
  SkipTraceBatchTicket,
  SkipTraceInput,
  SkipTracePerson,
  SkipTracePhone,
  SkipTraceProvider,
  SkipTraceResult,
} from "../types";

/**
 * Tracerfy skip-trace client. Docs:
 *   https://www.tracerfy.com/v1/api/skip-tracing-api-documentation/
 *
 * Auth: `Authorization: Bearer <TRACERFY_API_KEY>`.
 *
 * Endpoints used:
 *   - POST /trace/lookup/   single address, sync, 5 credits/hit
 *   - POST /trace/          batch (JSON body), async queue, 1 credit/lead
 *   - GET  /queue/:id       poll batch results
 *   - GET  /analytics/      account credit balance
 *
 * Rate limits (Tracerfy enforces, we don't):
 *   - 500 req/min on /trace/lookup/
 *   - 10 batches per 5 min on /trace/
 */

const BASE_URL = "https://tracerfy.com/v1/api";

type TracerfyPhone = {
  number: string;
  type?: string;
  dnc?: boolean;
  carrier?: string;
  rank: number;
};

type TracerfyEmail = {
  email: string;
  rank: number;
};

type TracerfyPerson = {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  property_owner?: boolean;
  litigator?: boolean;
  phones?: TracerfyPhone[];
  emails?: TracerfyEmail[];
};

type TracerfyLookupResponse = {
  address: string;
  city: string;
  state: string;
  zip?: string;
  hit: boolean;
  persons_count: number;
  credits_deducted: number;
  persons: TracerfyPerson[];
};

type TracerfyBatchResponse = {
  message?: string;
  queue_id: number | string;
  status?: string;
  created_at?: string;
  rows_uploaded?: number;
  trace_type?: string;
  credits_per_lead?: number;
  estimated_wait_seconds?: number;
};

type TracerfyQueueRow = TracerfyLookupResponse & {
  /** When polling, Tracerfy echoes the per-row identifier we sent in
   *  the batch. We pass through `propertyId` as `external_id` on
   *  submit so we can match results back. */
  external_id?: string;
};

type TracerfyAnalyticsResponse = {
  total_queues?: number;
  properties_traced?: number;
  queues_pending?: number;
  queues_completed?: number;
  balance: number;
};

export class TracerfyProvider implements SkipTraceProvider {
  readonly providerId = "tracerfy";

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new ConfigurationError("Tracerfy API key is required");
    }
  }

  async lookupSingle(input: SkipTraceInput): Promise<SkipTraceResult> {
    if (!input.address) {
      throw new ValidationError("address is required");
    }
    if (!input.city || !input.state) {
      throw new ValidationError("city and state are required");
    }

    const body: Record<string, unknown> = {
      address: input.address,
      city: input.city,
      state: input.state,
    };
    if (input.zip) body.zip = input.zip;
    if (input.firstName && input.lastName) {
      body.find_owner = false;
      body.first_name = input.firstName;
      body.last_name = input.lastName;
    } else {
      body.find_owner = true;
    }

    const data = await this.request<TracerfyLookupResponse>(
      "POST",
      "/trace/lookup/",
      body,
    );

    return {
      propertyId: input.propertyId,
      hit: !!data.hit,
      persons: (data.persons ?? []).map(mapPerson),
      creditsDeducted: data.credits_deducted ?? 0,
      raw: data,
    };
  }

  async submitBatch(inputs: SkipTraceInput[]): Promise<SkipTraceBatchTicket> {
    if (inputs.length === 0) {
      throw new ValidationError("submitBatch requires at least one input");
    }

    // Tracerfy's batch endpoint takes multipart/form-data — `json_data`
    // is a *form field* whose value is a stringified JSON array, NOT a
    // JSON property. The earlier JSON-body shape worked through their
    // earlier API revision but now returns 415 'Unsupported media type'.
    // We include `external_id` per row so the webhook can match results
    // back to our property.
    //
    // mail_address: Tracerfy's normal trace requires both a property
    // address column AND a mail address column. We don't yet thread the
    // homeowner's actual mailing address through SkipTraceInput; for
    // owner-occupied properties the property address IS the mail address
    // and for absentees it's an acceptable approximation that Tracerfy
    // still processes. Wiring real homeowner_mailing_address through is
    // a follow-up that requires extending SkipTraceInput + joining
    // homeowner_details in the runner's property fetch.
    const rows = inputs.map((i) => ({
      external_id: i.propertyId,
      address: i.address,
      city: i.city,
      state: i.state,
      zip: i.zip ?? "",
      mail_address: i.address,
      first_name: i.firstName ?? "",
      last_name: i.lastName ?? "",
    }));

    const form = new FormData();
    form.append("json_data", JSON.stringify(rows));
    form.append("address_column", "address");
    form.append("city_column", "city");
    form.append("state_column", "state");
    form.append("zip_column", "zip");
    form.append("mail_address_column", "mail_address");
    form.append("first_name_column", "first_name");
    form.append("last_name_column", "last_name");
    form.append("trace_type", "normal");

    const data = await this.requestForm<TracerfyBatchResponse>("/trace/", form);

    return {
      queueId: String(data.queue_id),
      estimatedWaitSeconds: data.estimated_wait_seconds ?? 0,
      creditsPerLead: data.credits_per_lead ?? 1,
    };
  }

  /**
   * POST a multipart/form-data body. Separate from `request()` because
   * fetch must not have a `Content-Type` header preset — the runtime sets
   * it to `multipart/form-data; boundary=…` automatically when given a
   * FormData body, and presetting breaks the boundary attachment.
   */
  private async requestForm<T>(path: string, form: FormData): Promise<T> {
    const url = `${BASE_URL}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        body: form,
      });
    } catch (e) {
      throw new ProviderError(
        e instanceof Error ? e.message : String(e),
        "tracerfy",
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `Tracerfy ${response.status}: ${text || response.statusText}`,
        "tracerfy",
        { status: response.status },
      );
    }

    return (await response.json()) as T;
  }

  async pollBatch(queueId: string): Promise<SkipTraceResult[] | null> {
    const data = await this.request<TracerfyQueueRow[] | { pending: boolean }>(
      "GET",
      `/queue/${encodeURIComponent(queueId)}`,
    );
    // Tracerfy returns the array of rows when complete; while pending,
    // some accounts return `{pending: true}` instead. Treat any non-array
    // shape as "still pending."
    if (!Array.isArray(data)) return null;
    return data.map((row) => ({
      propertyId: row.external_id ?? "",
      hit: !!row.hit,
      persons: (row.persons ?? []).map(mapPerson),
      creditsDeducted: row.credits_deducted ?? 0,
      raw: row,
    }));
  }

  async getBalance(): Promise<number> {
    const data = await this.request<TracerfyAnalyticsResponse>(
      "GET",
      "/analytics/",
    );
    return data.balance ?? 0;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ProviderError(
        e instanceof Error ? e.message : String(e),
        "tracerfy",
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `Tracerfy ${response.status}: ${text || response.statusText}`,
        "tracerfy",
        { status: response.status },
      );
    }

    return (await response.json()) as T;
  }
}

function mapPerson(p: TracerfyPerson): SkipTracePerson {
  return {
    firstName: p.first_name ?? null,
    lastName: p.last_name ?? null,
    phones: (p.phones ?? []).map(mapPhone),
    emails: (p.emails ?? []).map((e) => ({ email: e.email, rank: e.rank })),
    isOwner: p.property_owner === true,
  };
}

function mapPhone(p: TracerfyPhone): SkipTracePhone {
  const type =
    p.type === "Mobile"
      ? "Mobile"
      : p.type === "Landline"
        ? "Landline"
        : "Unknown";
  return {
    number: p.number,
    type,
    dnc: !!p.dnc,
    rank: p.rank,
    carrier: p.carrier ?? null,
  };
}

/** Factory used by the registry. Throws ConfigurationError if the env
 *  var isn't set. */
export function tracerfyFromEnv(): TracerfyProvider {
  const key = process.env.TRACERFY_API_KEY?.trim();
  if (!key) {
    throw new ConfigurationError("TRACERFY_API_KEY is not set");
  }
  return new TracerfyProvider(key);
}
