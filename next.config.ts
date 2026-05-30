import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  // xlsx uses dynamic `require('fs')` at runtime; Turbopack's bundling breaks
  // that, causing XLSX.readFile to throw "Cannot access file <path>" even
  // though the file exists. Keeping xlsx external to the server bundle lets it
  // resolve Node's fs the normal way.
  serverExternalPackages: ['xlsx'],
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
