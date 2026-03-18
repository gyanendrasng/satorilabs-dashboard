import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Type check runs out of memory on the VM — run tsc separately if needed
    ignoreBuildErrors: true,
  },
  async rewrites() {
    const guacProxyTarget =
      process.env.GUAC_PROXY_TARGET || 'http://localhost:8081';
    const guacPath = process.env.GUACAMOLE_PATH || '/guacamole';
    return [
      {
        source: `${guacPath}/:path*`,
        destination: `${guacProxyTarget}${guacPath}/:path*`,
      },
    ];
  },
};

export default nextConfig;
