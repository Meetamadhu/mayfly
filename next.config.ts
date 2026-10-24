import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  allowedDevOrigins: ["169.254.83.107"],
};

export default nextConfig;
