import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["tools/dutybell.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist/tools",
  target: "node18",
  banner: {
    js: "// dutybell v0.1.0 — single-file CLI, zero runtime dependencies\nimport { createRequire } from \"module\"; const require = createRequire(import.meta.url);",
  },
});
