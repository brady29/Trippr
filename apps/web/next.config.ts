import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The shared packages ship TypeScript source.
  transpilePackages: ["@trippr/contracts", "@trippr/rules"],
  poweredByHeader: false,
  // Lets the e2e server build alongside a running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // The left menu's account button sits in the bottom-left corner.
  devIndicators: { position: "bottom-right" },
};

export default config;
