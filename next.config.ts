import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` would otherwise generate AGENTS.md in the repo root when it detects an AI agent.
  agentRules: false,
  // Audio decoding registers many OPTIONAL codec packages through dynamic import(); bundling would try to
  // resolve all of them. Keep these as plain Node dependencies resolved at runtime on the server.
  serverExternalPackages: ["audio-decode", "@audio/decode", "music-metadata", "pg"],
  experimental: {
    // Uploads go through server actions; keep in step with MAX_BYTES in src/lib/upload-policy.ts (50 MB).
    serverActions: { bodySizeLimit: "55mb" },
    // The proxy (src/proxy.ts) buffers request bodies for the app, and Next caps that buffer at 10 MB by default:
    // anything larger arrives truncated ("Unexpected end of form"). Spatial control passes upload ~15 MB of raw
    // machine rasters and previs clips may reach 50 MB, so the buffer follows the same limit as server actions.
    // This is only the OUTER ceiling: every action enforces its own exact limits (spatial passes: exact canonical raster
    // sizes, a mask count bounded by the Shot's visible Characters, a bounded manifest; previs: MAX_PREVIS_BYTES 50 MB;
    // library uploads: upload-policy MAX_BYTES).
    proxyClientMaxBodySize: "55mb",
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
        ],
      },
    ];
  },
};

export default nextConfig;
