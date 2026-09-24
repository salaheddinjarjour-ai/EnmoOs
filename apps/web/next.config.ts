import path from "node:path";
import type { NextConfig } from "next";

const monorepoRoot = path.join(import.meta.dirname, "../..");

/*
 * Deployed to Cloudflare Workers through @opennextjs/cloudflare (`pnpm build:cf`). The app is a thin
 * client of the API: no middleware/proxy.ts (OpenNext has no Node middleware), no image optimiser,
 * and no Cloudflare bindings, so initOpenNextCloudflareForDev() is not needed for `next dev`.
 */
/*
 * Nothing is meant to frame the admin console (clickjacking), and the one-time /invite/<token> URL
 * must never leave in a Referer. The API is called with CORS fetches, which send Origin whatever
 * the referrer policy, so the API's CSRF origin check is unaffected. OpenNext applies these too.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@enmo/shared"],
  images: { unoptimized: true },
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
  headers: () => Promise.resolve([{ source: "/:path*", headers: SECURITY_HEADERS }]),
};

export default nextConfig;
