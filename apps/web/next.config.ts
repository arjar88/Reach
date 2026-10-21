import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@reach/shared"],
  serverExternalPackages: ["postgres"],
  experimental: { externalDir: true },
};

export default nextConfig;
