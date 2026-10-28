import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", "169.254.83.107"],
};

export default nextConfig;
