/* eslint-disable @typescript-eslint/no-explicit-any */
// Thin Telnyx v2 client with a code-level guard. Reads are unrestricted;
// create is limited to the plan's resource collections; update/delete/call-control
// only against inventoried IDs. Dial targets and limits are validated before any
// network call. Authorization is redacted in every log and error.
import { randomUUID } from "node:crypto";
import type { Config } from "./env";
import { Inventory } from "./inventory";
import { redactText } from "./redact";
import { Budget } from "./budget";

export const BASE_URL = "https://api.telnyx.com/v2";

export class GuardError extends Error {}
export class TelnyxError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
  }
}

const CREATE_COLLECTIONS = new Set([
  "credential_connections",
  "call_control_applications",
  "outbound_voice_profiles",
  "telephony_credentials",
  "calls",
]);
const MUTABLE_COLLECTIONS = new Set([
  "credential_connections",
  "call_control_applications",
  "outbound_voice_profiles",
  "telephony_credentials",
  "recordings",
]);

export function normalizeSipTarget(to: string): string {
  return to.trim().replace(/^sip:/i, "").toLowerCase();
}

/** Allowed Dial/transfer targets: owned phones, test credential SIP usernames, developer SIP endpoints. */
export function assertTargetAllowed(to: unknown, inv: Inventory, cfg: Config): void {
  if (typeof to !== "string" || !to) throw new GuardError("target missing");
  if (to.startsWith("+")) {
    if (!cfg.testPhones.includes(to)) throw new GuardError("target phone is not in DIRECT_CALL_TEST_PHONES");
    return;
  }
  const norm = normalizeSipTarget(to);
  const user = norm.split("@")[0];
  const dev = cfg.devSipEndpoints.map(normalizeSipTarget);
  if (dev.includes(norm)) return;
  if (inv.sipUsernames().map((u) => u.toLowerCase()).includes(user)) {
    const domain = norm.split("@")[1];
    if (!domain || domain === "sip.telnyx.com") return;
  }
  throw new GuardError("target is not an owned phone, test credential SIP username or developer SIP endpoint");
}

export function assertLegLimits(body: Record<string, unknown>, cfg: Config): void {
  const { limits } = cfg;
  const tl = body.time_limit_secs;
  if (typeof tl !== "number" || tl < 30 || tl > limits.maxLegSecs) {
    throw new GuardError(`Dial must set time_limit_secs between 30 and ${limits.maxLegSecs}`);
  }
  const to = body.timeout_secs;
  if (typeof to !== "number" || to <= 0 || to > limits.ringTimeoutSecs) {
    throw new GuardError(`Dial must set timeout_secs between 1 and ${limits.ringTimeoutSecs}`);
  }
}

export function assertAllowed(
  method: string,
  pathAndQuery: string,
  body: unknown,
  inv: Inventory,
  cfg: Config,
): void {
  const m = method.toUpperCase();
  if (m === "GET") return;
  const segs = pathAndQuery.split("?")[0].split("/").filter(Boolean);
  const b = (body ?? {}) as Record<string, unknown>;

  if (m === "POST") {
    if (segs.length === 1 && CREATE_COLLECTIONS.has(segs[0])) {
      if (segs[0] === "calls") {
        assertTargetAllowed(b.to, inv, cfg);
        assertLegLimits(b, cfg);
        if (b.from !== cfg.callerId) throw new GuardError("Dial from must be the configured caller ID");
        const app = inv.getRole("appId");
        if (!app || b.connection_id !== app || !inv.has(app)) {
          throw new GuardError("Dial connection_id must be the inventoried test application");
        }
        if (b.link_to !== undefined && !inv.has(String(b.link_to), ["call_leg"])) {
          throw new GuardError("link_to must be an inventoried leg");
        }
      }
      return;
    }
    if (segs.length === 3 && segs[0] === "telephony_credentials" && segs[2] === "token") {
      if (!inv.has(segs[1], ["telephony_credential"])) throw new GuardError("credential not in inventory");
      return;
    }
    if (segs.length === 4 && segs[0] === "calls" && segs[2] === "actions") {
      if (!inv.has(segs[1], ["call_leg"])) throw new GuardError("call-control refused: leg not in inventory");
      if (segs[3] === "transfer" || "to" in b) assertTargetAllowed(b.to, inv, cfg);
      const other = b.call_control_id;
      if (other !== undefined && !inv.has(String(other), ["call_leg"])) {
        throw new GuardError("call-control refused: referenced leg not in inventory");
      }
      return;
    }
    throw new GuardError(`POST ${segs.join("/")} is not allowed`);
  }

  if ((m === "PATCH" || m === "PUT" || m === "DELETE") && segs.length === 2 && MUTABLE_COLLECTIONS.has(segs[0])) {
    if (!inv.has(segs[1])) throw new GuardError(`${m} refused: ${segs[0]} ID is not in inventory`);
    return;
  }
  throw new GuardError(`${m} ${segs.join("/")} is not allowed`);
}

export interface ClientOptions {
  config: Config;
  inventory: Inventory;
  dryRun: boolean;
  budget?: Budget;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export class TelnyxClient {
  private sentOps = new Set<string>();
  private fetchImpl: typeof fetch;
  private log: (line: string) => void;
  public dryRunRequests: { method: string; path: string }[] = [];

  constructor(private opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.log = opts.log ?? ((l) => console.log(l));
  }

  private redact(s: string): string {
    return redactText(s, [this.opts.config.apiKey]);
  }

  async request<T = any>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    assertAllowed(method, pathAndQuery, body, this.opts.inventory, this.opts.config); // throws before any network call
    this.log(this.redact(`-> ${method} ${pathAndQuery}`));
    if (this.opts.dryRun) {
      this.dryRunRequests.push({ method, path: pathAndQuery });
      this.log(`   (dry-run: not sent)`);
      return { data: {}, meta: { total_pages: 1 } } as T;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URL}${pathAndQuery}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new TelnyxError(this.redact(`network error: ${(e as Error).message}`));
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* token endpoint returns plain text */
    }
    this.log(this.redact(`<- ${res.status} ${method} ${pathAndQuery}`));
    if (!res.ok) {
      throw new TelnyxError(this.redact(`${method} ${pathAndQuery} failed: ${res.status} ${text.slice(0, 500)}`), res.status, parsed);
    }
    return parsed as T;
  }

  async listAll<T = any>(pathAndQuery: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const sep = pathAndQuery.includes("?") ? "&" : "?";
      const r: any = await this.request("GET", `${pathAndQuery}${sep}page[size]=250&page[number]=${page}`);
      out.push(...((r.data as T[]) ?? []));
      const total = r.meta?.total_pages ?? 1;
      if (page >= total) break;
    }
    return out;
  }

  /**
   * Dial. Every Dial carries time_limit_secs and a ring timeout_secs. The command_id
   * comes from a durable operation UUID; the same operation is never sent twice by
   * this process (an uncertain outcome is reconciled by lookup, not re-sent).
   */
  async dial(params: { opId?: string; to: string; linkTo?: string; bridgeOnAnswer?: boolean; bridgeIntent?: boolean; clientState?: string }) {
    const { config, inventory, budget } = this.opts;
    const opId = params.opId ?? randomUUID();
    if (this.sentOps.has(opId)) throw new GuardError("operation already sent; reconcile by lookup instead of re-dialing");
    const body: Record<string, unknown> = {
      connection_id: inventory.getRole("appId"),
      to: params.to,
      from: config.callerId,
      timeout_secs: config.limits.ringTimeoutSecs,
      time_limit_secs: config.limits.maxLegSecs,
      command_id: opId,
    };
    if (params.linkTo) {
      body.link_to = params.linkTo;
      body.bridge_on_answer = params.bridgeOnAnswer ?? true;
      body.bridge_intent = params.bridgeIntent ?? false;
    }
    if (params.clientState) body.client_state = Buffer.from(params.clientState).toString("base64");
    assertAllowed("POST", "/calls", body, inventory, config); // validate before spending budget
    budget?.reserveAttempt();
    this.sentOps.add(opId);
    const r = await this.request<any>("POST", "/calls", body);
    const id: string | undefined = r?.data?.call_control_id;
    if (id) inventory.add("call_leg", id);
    return { opId, callControlId: id, callSessionId: r?.data?.call_session_id as string | undefined, raw: r };
  }
}
