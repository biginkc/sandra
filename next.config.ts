import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ["sandra.bmhgroup.com", "localhost:3000"],
      // The wizard now uploads CSVs to Supabase Storage and the server
      // action only receives the storage path + mapping (a few KB).
      // 1 MB is plenty; tighter than the previous 4 MB.
      bodySizeLimit: "1mb",
    },
  },
  // /search is the friendly entry point; the page itself stays at /properties
  // so saved links keep working. Temporary (307) on purpose: a permanent 308
  // would be cached by browsers forever. The query string is forwarded.
  async redirects() {
    return [
      { source: "/search", destination: "/properties", permanent: false },
    ];
  },
};

// withWorkflow wires the "use workflow" / "use step" directives into the
// Next.js build. Required for the CSV import workflow runner.
export default withSentryConfig(withWorkflow(nextConfig), {
  silent: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
