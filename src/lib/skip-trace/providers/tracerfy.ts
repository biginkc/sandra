import {
  ConfigurationError,
  ProviderError,
  ValidationError,
} from "@/lib/errors/classes";
import {
  isDoNotCallLabel,
  lineTypeFromVendorLabel,
} from "@/lib/messaging/line-type";

import type {
  SkipTraceBatchTicket,
  SkipTraceEmail,
  SkipTraceInput,
  SkipTraceMailingAddress,
  SkipTracePerson,
  SkipTracePhone,
  SkipTraceProvider,
  SkipTraceResult,
} from "../types";

/**
 * Tracerfy skip-trace client. Docs:
 *   https://www.tracerfy.com/skip-tracing-api-documentation/
 *
 * Auth: `Authorization: Bearer <TRACERFY_API_KEY>`.
 *
 * Endpoints used:
 *   - POST /trace/lookup/   single address, sync, 5 credits/hit
 *   - POST /trace/          batch, async queue, 1 normal / 2 advanced credits per hit
 *   - GET  /queue/:id       poll batch results
 *   - GET  /analytics/      account credit balance
 *
 * Rate limits (Tracerfy enforces, we don't):
 *   - 500 req/min on /trace/lookup/
 *   - 10 batches per 5 min on /trace/
 */

const BASE_URL = "https://tracerfy.com/v1/api";
const BALANCE_REQUEST_TIMEOUT_MS = 8_000;

export type TracerfyBatchTraceType = "normal" | "advanced";

export function tracerfyBatchCreditLimit(
  inputs: Array<Pick<SkipTraceInput, "firstName" | "lastName">>,
): number {
  if (inputs.length === 0) return 0;
  // Sandra has production evidence for Advanced's address-owned lookup shape.
  // Normal is cheaper when every submitted owner name is accurate, but it has
  // not been canaried here and a low-yield run would turn vendor misses into
  // 90-day reusable negatives. Reserve the proven Advanced ceiling until a
  // separately approved Normal-mode canary also defines safe miss fallback.
  return inputs.length * 2;
}

type TracerfyPhone = {
  number: string;
  type?: string;
  dnc?: boolean;
  tcpa?: boolean;
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

/**
 * One row of a batch result — webhook payload and `GET /queue/:id` share
 * this shape.
 *
 * IMPORTANT: live advanced-mode batches (first observed 2026-06-12) do
 * NOT nest owner data under `persons` the way `/trace/lookup/` does.
 * They return FLAT row-level fields: `first_name`, `last_name`,
 * `mobile_1..5`, `landline_1..5`, `email_1..5`, `mail_*`, and no `hit`
 * boolean at all. The first 12,282-row production run parsed rows with
 * the lookup shape, found no `persons`/`hit`, and silently dropped every
 * returned owner. `mapBatchRow` below handles both shapes.
 */
export type TracerfyBatchRow = Partial<TracerfyLookupResponse> & {
  /** When polling, Tracerfy echoes the per-row identifier we sent in
   *  the batch. We pass through `propertyId` as `external_id` on
   *  submit so we can match results back. */
  external_id?: string;
  /** Batch responses also surface the owner's mailing address as flat
   *  row-level fields. */
  mail_address?: string;
  mail_city?: string;
  mail_state?: string;
  mail_zip?: string;
  /** Flat owner fields (advanced/batch shape). Numbered phone/email
   *  fields (`mobile_1`…, `landline_1`…, `email_1`…) are probed via
   *  index access in `flatRowPerson` rather than enumerated here. */
  first_name?: string;
  last_name?: string;
  primary_phone?: string;
  primary_phone_type?: string;
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

  normalizeCachedResult(result: SkipTraceResult): SkipTraceResult | null {
    if (
      !result.raw ||
      typeof result.raw !== "object" ||
      Array.isArray(result.raw)
    ) {
      return null;
    }
    const raw = result.raw as Record<string, unknown>;
    if (raw.provider_no_data === true) {
      return {
        ...result,
        hit: false,
        persons: [],
        creditsDeducted: 0,
      };
    }

    try {
      const explicitMiss = raw.hit === false;
      const remapped = mapBatchRow(raw as TracerfyBatchRow);
      if (!remapped.hit && !explicitMiss) return null;
      if (result.hit && !remapped.hit) return null;
      return {
        ...remapped,
        propertyId: result.propertyId,
        creditsDeducted: 0,
      };
    } catch {
      return null;
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
      // Keep the production-proven address-owned lookup. Supplying an existing
      // contact name switches Tracerfy into a different name-match mode whose
      // misses would become 90-day reusable negatives before that mode has a
      // safe canary/fallback contract.
      find_owner: true,
    };
    if (input.zip) body.zip = input.zip;

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
    // Each row carries the owner's mailing address from
    // `homeowner_details.mailing_*` when we have it, falling back to the
    // property address for owner-occupied (or unknown) records.
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
    form.append("mail_zip_column", "mail_zip");
    form.append("first_name_column", "first_name");
    form.append("last_name_column", "last_name");
    // Keep the proven 2-credit Advanced owner-discovery mode even when owner
    // names are present. A Normal-mode rollout needs a separate canary plus a
    // safe fallback for misses before it can create reusable negative cache.
    // NB: the API enum is `advanced` — `enhanced` (the marketing name)
    // returns 400 "not a valid choice" (hit live 2026-06-12).
    const traceType: TracerfyBatchTraceType = "advanced";
    form.append("trace_type", traceType);

    const data = await this.requestForm<TracerfyBatchResponse>("/trace/", form);

    return {
      queueId: String(data.queue_id),
      estimatedWaitSeconds: data.estimated_wait_seconds ?? 0,
      creditsPerLead: data.credits_per_lead ?? 2,
      traceType,
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
    const data = await this.request<TracerfyBatchRow[] | { pending: boolean }>(
      "GET",
      `/queue/${encodeURIComponent(queueId)}`,
    );
    // Tracerfy returns the array of rows when complete; while pending,
    // some accounts return `{pending: true}` instead. Treat any non-array
    // shape as "still pending."
    if (!Array.isArray(data)) return null;
    // An EMPTY array is "no rows ready yet", not "completed with zero
    // rows" — a submitted batch always materializes ≥1 row. On
    // 2026-06-12 empty-array polls were finalized as complete, writing a
    // blanket error item for every submitted property.
    if (data.length === 0) return null;
    return data.map(mapBatchRow);
  }

  async getBalance(): Promise<number> {
    const data = await this.request<TracerfyAnalyticsResponse>(
      "GET",
      "/analytics/",
      undefined,
      AbortSignal.timeout(BALANCE_REQUEST_TIMEOUT_MS),
    );
    return data.balance ?? 0;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
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
        signal,
      });
    } catch (e) {
      const message =
        e instanceof DOMException && e.name === "TimeoutError"
          ? "Tracerfy balance request timed out"
          : e instanceof Error
            ? e.message
            : String(e);
      throw new ProviderError(message, "tracerfy");
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

/**
 * Map one batch result row (webhook payload or `GET /queue/:id`) to the
 * provider-agnostic result shape. Shared by `pollBatch` and the webhook
 * receiver so the two ingestion paths can never diverge again.
 *
 * Handles both row shapes:
 *  - lookup-style: `persons: [...]` + `hit` (older docs / normal traces)
 *  - flat advanced-mode: `first_name`/`last_name`, `mobile_N`,
 *    `landline_N`, `email_N` at the row level, no `hit` field (the live
 *    shape as of 2026-06-12)
 */
export function mapBatchRow(row: TracerfyBatchRow): SkipTraceResult {
  let persons = Array.isArray(row.persons) ? row.persons.map(mapPerson) : [];
  if (persons.length === 0) {
    const flat = flatRowPerson(row);
    if (flat) persons = [flat];
  }
  const rowMailing: SkipTraceMailingAddress | null =
    row.mail_address || row.mail_city || row.mail_state
      ? {
          street: row.mail_address ?? null,
          city: row.mail_city ?? null,
          state: row.mail_state ?? null,
          zip: row.mail_zip ?? null,
        }
      : null;
  // Respect a provider-declared `hit` when the field is present
  // (lookup-style rows) — overriding an explicit hit:false would promote
  // provider-declared misses to matches. Flat advanced-mode rows carry
  // no `hit` field at all; there, any extracted person counts as the paid
  // Advanced owner-resolution hit. Cache validity separately requires a
  // classified phone or email before that result can suppress a later trace.
  const hit = "hit" in row ? !!row.hit : persons.length > 0;
  return {
    // Tracerfy doesn't reliably round-trip external_id, so we treat
    // this as a hint at best — finalize matches via matchedAddress.
    propertyId: row.external_id ?? "",
    matchedAddress: {
      address: row.address ?? "",
      city: row.city ?? "",
      state: row.state ?? "",
    },
    hit,
    persons,
    creditsDeducted: row.credits_deducted ?? 0,
    mailingAddress: rowMailing,
    raw: row,
  };
}

/**
 * Build a SkipTracePerson from the flat row-level owner fields of an
 * advanced-mode batch row. Returns null when the row carries no owner
 * data at all (a true miss). Mobiles rank ahead of landlines — phone_1
 * feeds the SMS pipeline, so textable numbers come first. The flat shape
 * may expose compliance flags alongside the numbered phone fields. Explicit
 * DNC/TCPA/litigator signals are honored when present; historical queue rows
 * that omit them cannot be treated as registry-scrub proof.
 */
function flatRowPerson(row: TracerfyBatchRow): SkipTracePerson | null {
  const rec = row as Record<string, unknown>;
  const str = (key: string): string | null => {
    const v = rec[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const flagged = (key: string): boolean => {
    const value = rec[key];
    if (value === true || value === 1) return true;
    if (typeof value !== "string") return false;
    return ["true", "yes", "y", "1"].includes(value.trim().toLowerCase());
  };
  const rowSuppressed = flagged("litigator") || flagged("tcpa");

  const candidates: Array<Omit<SkipTracePhone, "rank">> = [];
  const primary = str("primary_phone");
  const primaryLabel = str("primary_phone_type");
  if (primary) {
    const normalizedType = lineTypeFromVendorLabel(primaryLabel);
    candidates.push({
      number: primary,
      type:
        normalizedType === "mobile"
          ? "Mobile"
          : normalizedType === "landline"
            ? "Landline"
            : "Unknown",
      dnc:
        rowSuppressed ||
        isDoNotCallLabel(primaryLabel) ||
        flagged("primary_phone_dnc") ||
        flagged("primary_phone_tcpa"),
      carrier: null,
    });
  }
  for (let i = 1; i <= 10; i++) {
    const n = str(`mobile_${i}`);
    if (n)
      candidates.push({
        number: n,
        type: "Mobile",
        dnc:
          rowSuppressed ||
          flagged(`mobile_${i}_dnc`) ||
          flagged(`mobile_${i}_tcpa`),
        carrier: null,
      });
  }
  for (let i = 1; i <= 10; i++) {
    const n = str(`landline_${i}`);
    if (n)
      candidates.push({
        number: n,
        type: "Landline",
        dnc:
          rowSuppressed ||
          flagged(`landline_${i}_dnc`) ||
          flagged(`landline_${i}_tcpa`),
        carrier: null,
      });
  }

  const phoneKey = (number: string) =>
    number.replace(/\D/g, "") || number.trim().toLowerCase();
  const deduped = new Map<string, Omit<SkipTracePhone, "rank">>();
  for (const candidate of candidates) {
    const key = phoneKey(candidate.number);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, candidate);
      continue;
    }
    const knownTypes = new Set(
      [existing.type, candidate.type].filter((type) => type !== "Unknown"),
    );
    deduped.set(key, {
      ...existing,
      type:
        knownTypes.size === 0
          ? "Unknown"
          : knownTypes.size === 1
            ? ([...knownTypes][0] ?? "Unknown")
            : "Unknown",
      dnc: existing.dnc || candidate.dnc,
    });
  }
  const typeOrder = { Mobile: 0, Landline: 1, Unknown: 2 } as const;
  const phones: SkipTracePhone[] = [...deduped.values()]
    .sort((a, b) => typeOrder[a.type] - typeOrder[b.type])
    .map((phone, index) => ({ ...phone, rank: index + 1 }));

  const emails: SkipTraceEmail[] = [];
  let emailRank = 1;
  for (let i = 1; i <= 10; i++) {
    const e = str(`email_${i}`);
    if (
      e &&
      !emails.some(
        (existing) => existing.email.toLowerCase() === e.toLowerCase(),
      )
    ) {
      emails.push({ email: e, rank: emailRank++ });
    }
  }

  const firstName = str("first_name");
  const lastName = str("last_name");

  if (!firstName && !lastName && phones.length === 0 && emails.length === 0) {
    return null;
  }

  return {
    firstName,
    lastName,
    phones,
    emails,
    // The advanced trace resolves THE owner of the submitted address —
    // that's the product. Flag accordingly so persist prefers this
    // person for homeowner_details.
    isOwner: true,
    mailingAddress: null,
  };
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
    phones: Array.isArray(p.phones)
      ? p.phones.map((phone) => mapPhone(phone, p.litigator === true))
      : [],
    emails: Array.isArray(p.emails)
      ? p.emails.map((e) => ({ email: e.email, rank: e.rank }))
      : [],
    isOwner: p.property_owner === true,
    mailingAddress,
  };
}

function mapPhone(p: TracerfyPhone, personSuppressed = false): SkipTracePhone {
  const type =
    p.type === "Mobile"
      ? "Mobile"
      : p.type === "Landline"
        ? "Landline"
        : "Unknown";
  return {
    number: p.number,
    type,
    dnc: personSuppressed || !!p.dnc || !!p.tcpa,
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
