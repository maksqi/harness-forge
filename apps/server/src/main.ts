// Placeholder entry point: health endpoint + static SPA serving.
// Replaced by the real server bootstrap in waves P0.5 (C4) and W1.1.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'

const port = Number(process.env.HF_PORT ?? 8787)
const hostname = process.env.HF_HOST ?? '127.0.0.1'

// Works from both src/main.ts (tsx) and dist/main.mjs (tsdown): both sit one level below apps/server.
const publicDir = fileURLToPath(new URL('../../web/.output/public', import.meta.url))
const spaFallback = join(publicDir, '200.html')

const app = new Hono()

app.get('/api/health', c => c.json({ ok: true }))
app.all('/api/*', c => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))

if (existsSync(spaFallback)) {
  const fallbackHtml = readFileSync(spaFallback, 'utf8')
  app.use('/*', serveStatic({ root: publicDir }))
  app.get('*', c => c.html(fallbackHtml))
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  // eslint-disable-next-line no-console -- placeholder until the logger lands (W1.1)
  console.log(`harness-forge server listening on http://${info.address}:${info.port}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
