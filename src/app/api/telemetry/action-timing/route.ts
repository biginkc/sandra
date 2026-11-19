// Sampled client timing beacons (src/lib/perf/client-action-timing.ts) become one structured log line each.
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 120) : null);

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = text(body.action);
    if (!action) return new Response(null, { status: 400 });
    console.info(JSON.stringify({
      event: "client_action.timing.v1",
      action,
      route: text(body.route),
      queueMs: num(body.queueMs),
      networkMs: num(body.networkMs),
      totalMs: num(body.totalMs),
      ok: body.ok === true,
    }));
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 400 });
  }
}
