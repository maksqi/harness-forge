import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  vue: true,
  markdown: false,
  // The pnpm integration would force every dependency into the catalog, and its fixer rewrites
  // pnpm-workspace.yaml even without --fix. Only shared versions live in the catalog.
  pnpm: false,
  ignores: [
    'apps/web/app/components/ui/**',
    'apps/web/app/components/ai-elements/**',
    'apps/server/drizzle/**',
    '**/.nuxt/**',
    '**/.output/**',
    '**/dist/**',
    'data/**',
    '.tmp/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
  ],
})
