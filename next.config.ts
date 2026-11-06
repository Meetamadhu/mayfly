import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", "169.254.83.107"],
  async headers() {
    return [
      {
        // Sandboxed preview pages have a "null" origin, so loading Mayfly's public fonts is cross-origin.
        source: "/fonts/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
};

export default nextConfig;
