import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow accessing the dev server from your LAN IP (prevents HMR being blocked).
  allowedDevOrigins: ["192.168.56.1"],
};

export default nextConfig;
