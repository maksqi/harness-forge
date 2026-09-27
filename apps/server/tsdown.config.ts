import { defineConfig } from 'tsdown'

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
    // Every other dependency stays external and is loaded from node_modules at runtime.
    alwaysBundle: [/^@harness-forge\//],
  },
})
