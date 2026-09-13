import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

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
};

// withWorkflow wires the "use workflow" / "use step" directives into the
// Next.js build. Required for the CSV import workflow runner.
export default withWorkflow(nextConfig);
