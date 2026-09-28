import { defineConfig } from 'tsdown'

// Production build of the server: `dist/main.mjs` (+ source map), started by `pnpm start` and the Docker image.
// At runtime the server resolves its files from the package root (`src/paths.ts`), not from `dist/`: migrations in
// `drizzle/`, the models.dev snapshot in `assets/catalog/`, LobeHub icons from `node_modules` and the SPA in
// `../web/.output/public` (or `HF_WEB_DIR`). Nothing is copied into `dist/`.
export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22.12',
  outDir: 'dist',
  // Output: dist/main.mjs (fixed .mjs extension on platform "node").
  fixedExtension: true,
  clean: true,
  sourcemap: true,
  dts: false,
  deps: {
    // Workspace packages export TypeScript source, so they are bundled.
    alwaysBundle: [/^@harness-forge\//],
    // Every other dependency stays external and is loaded from node_modules at runtime: the build fails when a package
    // from node_modules would be inlined (an import of a devDependency or of an undeclared package). Declare runtime
    // imports in the `dependencies` of apps/server/package.json; the Docker image installs only those.
    onlyBundle: [],
  },
})
