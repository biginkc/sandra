import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import {
  pool,
  assertFixtureDatabase,
  ORG_A,
  ORG_B,
  USER_A,
  USER_B,
} from "../shared/database.js";

// Synthetic local sessions only. This is not the production Hugo boundary.
const sessions = new Map([
  ["synthetic-a", { org: ORG_A, user: USER_A }],
  ["synthetic-b", { org: ORG_B, user: USER_B }],
]);
const ELECTRIC = "http://127.0.0.1:58783/v1/shape";
const columns =
  "org_id,conversation_id,property_id,last_preview,latest_message_at,outcome,assigned_user_id,revision";
type Session = { org: string; user: string };
type Workset = Session & {
  id: string;
  ids: string[];
  epoch: string;
  expiresAt: number;
  handle?: string;
};
export type TestHooks = { afterBody?: () => Promise<void> };
class Failure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "private, no-store",
  });
  res.end(JSON.stringify(value));
}
async function session(req: IncomingMessage) {
  const s = sessions.get(
    (req.headers.authorization ?? "").replace(/^Bearer /, ""),
  );
  if (!s) throw new Failure(401, "synthetic_session_required");
  return s;
}
async function membership(s: Session) {
  const { rows } = await pool.query(
    "select active,access_epoch::text as epoch from inbox_t1.memberships where org_id=$1 and user_id=$2",
    [s.org, s.user],
  );
  if (!rows[0]?.active) throw new Failure(403, "membership_revoked");
  return rows[0].epoch as string;
}
async function readJson(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2048) throw new Failure(413, "body_too_large");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Failure(400, "invalid_json");
  }
}
export async function startGateway({
  port = 58784,
  ttlMs = 60_000,
  hooks = {},
  strategy = "explicit_ids",
}: {
  port?: number;
  ttlMs?: number;
  hooks?: TestHooks;
  strategy?: "explicit_ids" | "membership_subquery";
} = {}) {
  await assertFixtureDatabase();
  const worksets = new Map<string, Workset>();
  const inFlight = new Map<string, number>();
  const stats = {
    denialReasons: [] as string[],
    forwardedRows: 0,
    upstreamRequests: 0,
    maxUpstreamUrlBytes: 0,
    denied: 0,
  };
  const server = createServer(async (req, res) => {
    try {
      const s = await session(req);
      const epoch = await membership(s);
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (req.method === "POST" && url.pathname === "/worksets") {
        const body = await readJson(req);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some((k) => k !== "limit") ||
          !Number.isInteger(body.limit) ||
          body.limit < 1 ||
          body.limit > (strategy === "explicit_ids" ? 100 : 500)
        )
          throw new Failure(400, "limit_exceeds_strategy_bound");
        // One statement fixes the ordered membership, even while row fields later change.
        const { rows } = await pool.query(
          "select conversation_id from inbox_t1.conversation_summaries where org_id=$1 order by latest_message_at desc,conversation_id desc limit $2",
          [s.org, body.limit],
        );
        for (const [id, w] of worksets)
          if (w.expiresAt <= Date.now()) {
            worksets.delete(id);
            await pool.query(
              "delete from inbox_t1.sync_workset_members where workset_id=$1",
              [id],
            );
          }
        const active = [...worksets.values()]
          .filter((w) => w.user === s.user)
          .sort((a, b) => a.expiresAt - b.expiresAt);
        if (active.length >= 2)
          throw new Failure(429, "at_most_two_generations");
        const w: Workset = {
          ...s,
          id: randomUUID(),
          ids: rows.map((r) => r.conversation_id),
          epoch,
          expiresAt: Date.now() + ttlMs,
        };
        if (strategy === "membership_subquery")
          await pool.query(
            "insert into inbox_t1.sync_workset_members(workset_id,org_id,conversation_id) select $1,$2,x from unnest($3::uuid[]) x",
            [w.id, w.org, w.ids],
          );
        worksets.set(w.id, w);
        return json(res, 201, {
          id: w.id,
          ids: w.ids,
          epoch,
          expiresAt: w.expiresAt,
          shapeUrl: `http://127.0.0.1:${port}/shape/${w.id}`,
        });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/worksets/")) {
        const id = url.pathname.split("/")[2];
        const w = worksets.get(id);
        if (!w || w.user !== s.user || w.org !== s.org)
          throw new Failure(404, "workset_missing");
        worksets.delete(id);
        await pool.query(
          "delete from inbox_t1.sync_workset_members where workset_id=$1",
          [id],
        );
        return json(res, 200, { deleted: true });
      }
      if (req.method !== "GET" || !url.pathname.startsWith("/shape/"))
        throw new Failure(404, "not_found");
      const w = worksets.get(url.pathname.split("/")[2]);
      if (!w || w.org !== s.org || w.user !== s.user)
        throw new Failure(404, "workset_missing");
      const check = async () => {
        if (w.expiresAt <= Date.now())
          throw new Failure(410, "workset_expired");
        if ((await membership(s)) !== w.epoch)
          throw new Failure(403, "access_epoch_changed");
      };
      await check();
      const allowed = new Set(["offset", "handle", "live", "cursor", "log"]);
      for (const key of url.searchParams.keys())
        if (!allowed.has(key))
          throw new Failure(400, "protocol_parameter_not_allowed");
      for (const key of allowed)
        if (url.searchParams.getAll(key).length > 1)
          throw new Failure(400, "duplicate_parameter");
      if (url.searchParams.has("log") && url.searchParams.get("log") !== "full")
        throw new Failure(400, "unsupported_log_mode");
      const handle = url.searchParams.get("handle");
      if (handle && handle !== w.handle)
        throw new Failure(403, "handle_not_bound_to_workset");
      const offset = url.searchParams.get("offset") ?? "-1";
      if (!/^(-1|\d+_(\d+|inf)|now)$/.test(offset))
        throw new Failure(400, "invalid_offset");
      if (offset !== "-1" && !handle) throw new Failure(400, "handle_required");
      const upstream = new URL(ELECTRIC);
      for (const [k, v] of url.searchParams) upstream.searchParams.set(k, v);
      upstream.searchParams.set("offset", offset);
      upstream.searchParams.set("table", "inbox_t1.conversation_summaries");
      upstream.searchParams.set("columns", columns);
      upstream.searchParams.set("replica", "full");
      // IDs are server-selected validated UUIDs. Alternative subquery has the same fixed server workset boundary.
      if (strategy === "membership_subquery") {
        upstream.searchParams.set(
          "where",
          "org_id = $1 AND conversation_id IN (SELECT conversation_id FROM inbox_t1.sync_workset_members WHERE workset_id = $2 AND org_id = $1)",
        );
        upstream.searchParams.set("params[1]", s.org);
        upstream.searchParams.set("params[2]", w.id);
      } else {
        upstream.searchParams.set(
          "where",
          `org_id = $1 AND conversation_id IN (${w.ids.map((_, i) => `$${i + 2}`).join(",") || "NULL"})`,
        );
        upstream.searchParams.set("params[1]", s.org);
        w.ids.forEach((id, i) =>
          upstream.searchParams.set(`params[${i + 2}]`, id),
        );
      }
      stats.maxUpstreamUrlBytes = Math.max(
        stats.maxUpstreamUrlBytes,
        upstream.href.length,
      );
      stats.upstreamRequests++;
      const inflightKey = s.user;
      if ((inFlight.get(inflightKey) ?? 0) >= 4)
        throw new Failure(429, "at_most_four_polls");
      inFlight.set(inflightKey, (inFlight.get(inflightKey) ?? 0) + 1);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      let response: Response;
      let bytes: Buffer;
      try {
        response = await fetch(upstream, { signal: controller.signal });
        const reader = response.body?.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        if (reader)
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 2_000_000) {
              controller.abort();
              throw new Failure(502, "bounded_body_exceeded");
            }
            parts.push(value);
          }
        bytes = Buffer.concat(parts);
      } finally {
        clearTimeout(timeout);
        inFlight.set(inflightKey, (inFlight.get(inflightKey) ?? 1) - 1);
      }
      // Buffer a bounded response, then recheck auth immediately before any body forwarding.
      await hooks.afterBody?.();
      await check();
      const nextHandle = response.headers.get("electric-handle");
      if (nextHandle) w.handle = nextHandle;
      if (response.status === 409) w.handle = nextHandle ?? undefined;
      const headers: Record<string, string> = {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
        "cache-control": "private, no-store",
      };
      for (const [key, value] of response.headers)
        if (key.startsWith("electric-")) headers[key] = value;
      try {
        const body = JSON.parse(bytes.toString());
        if (Array.isArray(body))
          stats.forwardedRows += body.filter((r: any) => r.value).length;
      } catch {
        /* upstream non-JSON errors remain bounded */
      }
      res.writeHead(response.status, headers);
      res.end(bytes);
    } catch (e) {
      stats.denied++;
      const known = e instanceof Failure;
      stats.denialReasons.push(known ? e.message : "sync_unavailable");
      json(res, known ? e.status : 503, {
        error: known ? e.message : "sync_unavailable",
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    stats,
    worksets,
    expire: (id: string) => {
      const w = worksets.get(id);
      if (w) w.expiresAt = 0;
    },
    close: async () => {
      await pool.query(
        "delete from inbox_t1.sync_workset_members where workset_id=any($1::uuid[])",
        [[...worksets.keys()]],
      );
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      });
    },
  };
}
