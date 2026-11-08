import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The shared packages ship TypeScript source.
  transpilePackages: ["@trippr/contracts", "@trippr/rules"],
  poweredByHeader: false,
  // Lets the e2e server build alongside a running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default config;
