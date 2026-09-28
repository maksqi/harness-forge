// Refreshes the bundled models.dev snapshot (apps/server/assets/catalog/models-dev.json): downloads
// https://models.dev/api.json and keeps only the builtin providers and the fields the model catalog uses
// (`trimModelsDevForBundle`, apps/server/src/catalog/models-dev.ts). Run with `pnpm catalog:update`.
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  MODELS_DEV_URL,
  modelsDevModelCount,
  serializeModelsDevSnapshot,
  trimModelsDevForBundle,
} from '../apps/server/src/catalog/models-dev.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'apps', 'server', 'assets', 'catalog', 'models-dev.json')
const TIMEOUT_MS = 60_000
/** The full document is about 5 MB; refuse anything absurd. */
const MAX_BYTES = 50 * 1024 * 1024

async function main(): Promise<void> {
  const response = await fetch(MODELS_DEV_URL, {
    headers: { 'accept': 'application/json', 'user-agent': 'harness-forge catalog:update' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok)
    throw new Error(`${MODELS_DEV_URL} answered HTTP ${response.status}.`)
  const text = await response.text()
  if (text.length > MAX_BYTES)
    throw new Error(`${MODELS_DEV_URL} returned more than ${MAX_BYTES} bytes.`)
  const snapshot = trimModelsDevForBundle(JSON.parse(text) as unknown, Date.now())
  const output = serializeModelsDevSnapshot(snapshot)
  await mkdir(dirname(TARGET), { recursive: true })
  const temporary = `${TARGET}.tmp`
  await writeFile(temporary, output, 'utf8')
  await rename(temporary, TARGET)
  const providers = Object.keys(snapshot.providers)
  console.log(`Wrote ${relative(ROOT, TARGET)}: ${providers.length} providers (${providers.join(', ')}), ${modelsDevModelCount(snapshot)} models, ${(output.length / 1024).toFixed(1)} KB.`)
}

main().catch((error: unknown) => {
  console.error(`catalog:update failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
