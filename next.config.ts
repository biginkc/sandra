import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ["sandra.bmhgroup.com", "localhost:3000"],
      // Headroom for the import wizard. Rows are trimmed to mapped columns
      // before submit (see src/lib/csv/trim-rows.ts), which keeps a typical
      // 1,800-row D4D import around 1 MB. The 4 MB ceiling is belt-and-
      // braces — any single CSV that exceeds this should move to the
      // Storage upload path, not push the limit higher.
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
