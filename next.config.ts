import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ["sandra.bmhgroup.com", "localhost:3000"],
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
