export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.SANDRA_PERFORMANCE_TELEMETRY !== "1") return;
  const [{ registerOTel }, { performanceExporter }] = await Promise.all([
    import("@vercel/otel"), import("./lib/performance/trace-exporter"),
  ]);
  registerOTel({
    serviceName: "sandra",
    instrumentations: [],
    traceExporter: performanceExporter,
  });
}
