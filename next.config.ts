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
