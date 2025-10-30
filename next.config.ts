import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  eslint: {
    // Ignore ESLint errors during production builds
    ignoreDuringBuilds: true,
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
