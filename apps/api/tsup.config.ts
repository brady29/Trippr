import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * Bundles the API and the workspace packages it imports into dist/server.js, and the data load job into dist/load-bundle.js.
 * npm dependencies stay external and are installed in the Docker image.
 * The .cypher files are copied next to the bundle (see repositories/queries.ts).
 */
export default defineConfig({
  entry: ["src/server.ts", "src/flight-snapshots.ts", "src/load-bundle.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: [/^@trippr\//],
  onSuccess: async () => {
    cpSync("src/repositories/cypher", "dist/cypher", { recursive: true });
  },
});
