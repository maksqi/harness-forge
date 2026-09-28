// Filesystem locations of the server package, the workspace and installed packages. Every lookup works from the
// TypeScript sources (tsx, Vitest: `src/**`) and from the bundled build (`dist/main.mjs`), because both sit below the
// server package root.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Name of the server package (used to find its root directory). */
export const SERVER_PACKAGE_NAME = '@harness-forge/server'
/** Name of the root workspace package (its version is the app version). */
export const ROOT_PACKAGE_NAME = 'harness-forge'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

interface PackageJson {
  name?: string
  version?: string
}

/** Walks from `start` up to the filesystem root and returns the first directory accepted by `predicate`. */
export function findUp(start: string, predicate: (dir: string) => boolean): string | null {
  let dir = start
  for (;;) {
    if (predicate(dir))
      return dir
    const parent = dirname(dir)
    if (parent === dir || dir === parse(dir).root)
      return null
    dir = parent
  }
}

/** Reads `<dir>/package.json`; null when it is missing or invalid. */
export function readPackageJson(dir: string): PackageJson | null {
  const file = join(dir, 'package.json')
  if (!existsSync(file))
    return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as PackageJson : null
  }
  catch {
    return null
  }
}

/** Nearest ancestor of `from` (inclusive) that contains `pnpm-workspace.yaml`, or null. */
export function findWorkspaceRoot(from: string): string | null {
  return findUp(from, dir => existsSync(join(dir, 'pnpm-workspace.yaml')))
}

let cachedServerRoot: string | undefined

/** Root directory of `@harness-forge/server` (`apps/server`). */
export function serverPackageRoot(): string {
  if (cachedServerRoot === undefined) {
    const root = findUp(moduleDir, dir => readPackageJson(dir)?.name === SERVER_PACKAGE_NAME)
    if (root === null)
      throw new Error(`Cannot find the ${SERVER_PACKAGE_NAME} package root above ${moduleDir}.`)
    cachedServerRoot = root
  }
  return cachedServerRoot
}

/** Generated Drizzle migrations (`apps/server/drizzle`, contains `meta/_journal.json`). */
export function migrationsFolder(): string {
  return join(serverPackageRoot(), 'drizzle')
}

/** Output of `nuxt generate` served by the production server (`apps/web/.output/public`). */
export function webPublicDir(): string {
  return join(serverPackageRoot(), '..', 'web', '.output', 'public')
}

/** `nitro.json` written next to the generated SPA (`framework.version` = Nuxt version of the build). */
export function webBuildInfoFile(): string {
  return join(serverPackageRoot(), '..', 'web', '.output', 'nitro.json')
}

/**
 * Directory of an installed package resolvable from the server package, or null. Works for packages that do not
 * export `./package.json` (the entry point is resolved and the tree is walked up to the package's own manifest).
 */
export function resolvePackageDir(name: string): string | null {
  try {
    return dirname(require.resolve(`${name}/package.json`))
  }
  catch {
    // `./package.json` is not exported: fall back to the entry point.
  }
  try {
    const entry = require.resolve(name)
    return findUp(dirname(entry), dir => readPackageJson(dir)?.name === name)
  }
  catch {
    return null
  }
}

/** Version of an installed package, or null when it cannot be resolved. */
export function packageVersion(name: string): string | null {
  const dir = resolvePackageDir(name)
  const version = dir === null ? undefined : readPackageJson(dir)?.version
  return typeof version === 'string' ? version : null
}

/** The harness-forge version: the root workspace package, else the server package. */
export function appVersion(): string {
  const serverRoot = serverPackageRoot()
  const workspaceRoot = findWorkspaceRoot(serverRoot)
  const rootPackage = workspaceRoot === null ? null : readPackageJson(workspaceRoot)
  if (rootPackage?.name === ROOT_PACKAGE_NAME && typeof rootPackage.version === 'string')
    return rootPackage.version
  return readPackageJson(serverRoot)?.version ?? '0.0.0'
}
