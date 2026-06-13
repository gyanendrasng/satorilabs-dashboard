import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  // xlsx and pdfjs-dist both rely on dynamic Node resolution at runtime
  // (xlsx: `require('fs')`; pdfjs-dist: locating its worker .mjs alongside
  // the package). Turbopack's bundling breaks both, surfacing as
  // "Cannot access file <path>" from xlsx and
  // "Cannot find module .../pdf.worker.mjs" from pdfjs-dist (the ZLOAD1
  // PDF parser then falls back to PENDING placeholder rows). Keeping them
  // external lets Node resolve the packages from node_modules normally.
  //
  // @google/genai is ESM-only (`"type": "module"`) with Node/web conditional
  // exports — webpack's resolver fails to walk those conditions during the
  // server bundle. Marking it external lets the Node runtime do the resolve.
  serverExternalPackages: ['xlsx', 'pdfjs-dist', '@google/genai'],
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
