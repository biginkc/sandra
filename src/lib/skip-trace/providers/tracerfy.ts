import {
  ConfigurationError,
  ProviderError,
  ValidationError,
} from "@/lib/errors/classes";

import type {
  SkipTraceBatchTicket,
  SkipTraceInput,
  SkipTraceMailingAddress,
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

/** Per-person nested mailing address — returned by /trace/lookup/. */
type TracerfyMailingAddress = {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
};

type TracerfyPerson = {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  property_owner?: boolean;
  litigator?: boolean;
  phones?: TracerfyPhone[];
  emails?: TracerfyEmail[];
  mailing_address?: TracerfyMailingAddress;
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
  /** Batch responses also surface the owner's mailing address as flat
   *  row-level fields (no zip in the batch shape per Tracerfy's docs). */
  mail_address?: string;
  mail_city?: string;
  mail_state?: string;
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

    const persons = (data.persons ?? []).map(mapPerson);
    // Surface the first owner's mailing address at the result level so
    // callers don't have to hunt through `persons` for the owner record.
    // Falls back to any person's mailing address if no one is flagged
    // as `property_owner`.
    const ownerMailing =
      persons.find((p) => p.isOwner)?.mailingAddress ??
      persons.find((p) => !!p.mailingAddress)?.mailingAddress ??
      null;

    return {
      propertyId: input.propertyId,
      hit: !!data.hit,
      persons,
      creditsDeducted: data.credits_deducted ?? 0,
      mailingAddress: ownerMailing,
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
    // mail_address_column is required for `normal`/`custom` trace types.
    // Each row carries the owner's actual mailing address from
    // `homeowner_details.mailing_*` when we have it, falling back to
    // the property address for owner-occupied (or unknown) records.
    const rows = inputs.map((i) => ({
      external_id: i.propertyId,
      address: i.address,
      city: i.city,
      state: i.state,
      zip: i.zip ?? "",
      mail_address: i.mailingAddress ?? i.address,
      mail_city: i.mailingCity ?? i.city,
      mail_state: i.mailingState ?? i.state,
      mail_zip: i.mailingZip ?? i.zip ?? "",
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
    form.append("mail_city_column", "mail_city");
    form.append("mail_state_column", "mail_state");
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
    return data.map((row) => {
      const persons = (row.persons ?? []).map(mapPerson);
      // Batch responses surface mailing fields at the row level (per
      // Tracerfy docs: `mail_address`, `mail_city`, `mail_state`).
      // No `mail_zip` in the batch shape today.
      const rowMailing: SkipTraceMailingAddress | null =
        row.mail_address || row.mail_city || row.mail_state
          ? {
              street: row.mail_address ?? null,
              city: row.mail_city ?? null,
              state: row.mail_state ?? null,
              zip: null,
            }
          : null;
      return {
        // Tracerfy doesn't reliably round-trip external_id, so we treat
        // this as a hint at best — finalize matches via matchedAddress.
        propertyId: row.external_id ?? "",
        matchedAddress: {
          address: row.address ?? "",
          city: row.city ?? "",
          state: row.state ?? "",
        },
        hit: !!row.hit,
        persons,
        creditsDeducted: row.credits_deducted ?? 0,
        mailingAddress: rowMailing,
        raw: row,
      };
    });
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
  const m = p.mailing_address;
  const mailingAddress: SkipTraceMailingAddress | null =
    m && (m.street || m.city || m.state || m.zip)
      ? {
          street: m.street ?? null,
          city: m.city ?? null,
          state: m.state ?? null,
          zip: m.zip ?? null,
        }
      : null;
  return {
    firstName: p.first_name ?? null,
    lastName: p.last_name ?? null,
    phones: (p.phones ?? []).map(mapPhone),
    emails: (p.emails ?? []).map((e) => ({ email: e.email, rank: e.rank })),
    isOwner: p.property_owner === true,
    mailingAddress,
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
