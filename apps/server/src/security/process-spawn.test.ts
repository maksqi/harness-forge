// Spawn guard (Phase 8, C21-T7; ARCHITECTURE.md 6.17): only three server modules may load `node:child_process`:
// `workspace/shell.ts` (the shell runner, the only place that starts a shell), `workspace/git.ts` (the hardened git
// runner, the only place that runs git) and `mcp/stdio-transport.ts` (MCP stdio servers, an argument array). Those three
// import only `spawn` (no `exec`, `execSync`, `execFile`, `fork`) and never pass `shell: true`. Test code
// (`*.test.ts`, `*.test-util.ts`, `__fixtures__/`) is exempt.
//
// The scan parses every source file that mentions `child_process` with the TypeScript compiler, so comments do not
// count, and every string literal `child_process` / `node:child_process` does: static, side-effect and dynamic imports,
// re-exports, `require`, `createRequire(…)('child_process')`. Type-only imports (`import type …`, `import('…').X` in a
// type) load nothing and are allowed everywhere.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTempDir } from '../workspace/git.test-util.ts'

/** `apps/server/src`. */
const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The modules that may spawn processes, relative to `SOURCE_ROOT`. */
const ALLOWED_MODULES = ['mcp/stdio-transport.ts', 'workspace/git.ts', 'workspace/shell.ts']
/** What the allowed modules may import from `child_process` (besides types). */
const ALLOWED_IMPORTS = ['spawn']
const MODULE_NAMES = new Set(['child_process', 'node:child_process'])
const SOURCE_FILE = /\.[cm]?[jt]s$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

/** One place a file loads `child_process`. */
interface SpawnUse {
  /** POSIX path relative to the scanned root. */
  readonly file: string
  readonly line: number
  /** The value bindings of an import or re-export (`*` for a namespace or default import); empty for other forms. */
  readonly names: readonly string[]
  /** `shell: true` appears in the file. */
  readonly shellTrue: boolean
}

function isTestCode(file: string): boolean {
  return /\.test\.[cm]?[jt]s$/.test(file) || /\.test-util\.[cm]?[jt]s$/.test(file) || file.split('/').includes('__fixtures__')
}

function scriptKind(file: string): ts.ScriptKind {
  return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

/** True when the module specifier `literal` belongs to a declaration that loads nothing at run time. */
function typeOnly(literal: ts.StringLiteralLike): boolean {
  const parent = literal.parent
  if (ts.isImportDeclaration(parent))
    return parent.importClause?.isTypeOnly === true
  if (ts.isExportDeclaration(parent))
    return parent.isTypeOnly
  // `typeof import('node:child_process')` / `import('node:child_process').ChildProcess` in a type position.
  return ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)
}

/** The value names an import or re-export of `literal` binds. */
function boundNames(literal: ts.StringLiteralLike): string[] {
  const parent = literal.parent
  if (ts.isImportDeclaration(parent)) {
    const clause = parent.importClause
    if (clause === undefined)
      return []
    const names: string[] = clause.name === undefined ? [] : ['*']
    const bindings = clause.namedBindings
    if (bindings !== undefined && ts.isNamespaceImport(bindings))
      names.push('*')
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly)
          names.push((element.propertyName ?? element.name).text)
      }
    }
    return names
  }
  if (ts.isExportDeclaration(parent)) {
    const clause = parent.exportClause
    if (clause === undefined || !ts.isNamedExports(clause))
      return ['*']
    return clause.elements.filter(element => !element.isTypeOnly).map(element => (element.propertyName ?? element.name).text)
  }
  return []
}

/** Every place `text` loads `child_process` (see the module comment). */
function scanSource(file: string, text: string): SpawnUse[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const uses: SpawnUse[] = []
  const shellTrue = /\bshell\s*:\s*true\b/.test(text)
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && MODULE_NAMES.has(node.text) && !typeOnly(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      uses.push({ file, line: line + 1, names: boundNames(node), shellTrue })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return uses
}

/** Every source file below `root` (POSIX paths relative to it), declaration files and `node_modules` excluded. */
async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name))
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter(file => !file.split('/').includes('node_modules'))
    .sort()
}

/** The guard's findings for the tree at `root`: forbidden loaders, and allowed modules that import more than `spawn`. */
async function checkSpawnGuard(root: string): Promise<{ users: string[], violations: string[] }> {
  const users = new Set<string>()
  const violations: string[] = []
  for (const file of await sourceFiles(root)) {
    if (isTestCode(file))
      continue
    const text = await readFile(join(root, file), 'utf8')
    if (!text.includes('child_process'))
      continue
    for (const use of scanSource(file, text)) {
      users.add(file)
      if (!ALLOWED_MODULES.includes(file))
        violations.push(`${file}:${use.line} loads child_process`)
      else if (use.names.some(name => !ALLOWED_IMPORTS.includes(name)))
        violations.push(`${file}:${use.line} imports ${use.names.join(', ')} from child_process (only spawn)`)
      else if (use.shellTrue)
        violations.push(`${file} passes shell: true`)
    }
  }
  return { users: [...users].sort(), violations }
}

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true })
})

describe('spawn guard (C21-T7)', () => {
  it('only the shell runner, the git runner and the MCP stdio transport load child_process (only spawn)', async () => {
    const { users, violations } = await checkSpawnGuard(SOURCE_ROOT)
    expect(violations).toEqual([])
    // The scan sees the real loaders, so an empty violation list means something.
    expect(users).toEqual(ALLOWED_MODULES)
  })

  it('fails on a planted loader in a copy of the source tree', async () => {
    const copy = await makeTempDir('hf-spawn-guard-')
    temps.push(copy)
    await cp(SOURCE_ROOT, copy, {
      recursive: true,
      filter: source => !source.split(sep).includes('node_modules'),
    })
    const planted = join(copy, 'planted')
    await mkdir(planted)
    const plant = (name: string, text: string): Promise<void> => writeFile(join(planted, name), text)
    await plant('static.ts', `import { exec } from 'node:child_process'\nexport const run = exec\n`)
    await plant('side-effect.ts', `import 'child_process'\n`)
    await plant('dynamic.ts', `export async function load(): Promise<unknown> {\n  return import('node:child_process')\n}\n`)
    await plant('reexport.ts', `export { execFile } from 'child_process'\n`)
    await plant('required.cjs', `const childProcess = require('child_process')\nmodule.exports = childProcess\n`)
    await plant('create-require.ts', `import { createRequire } from 'node:module'\nexport const childProcess = createRequire(import.meta.url)('node:child_process')\n`)
    // Not violations: type-only imports, comments, test code.
    await plant('types-only.ts', `import type { ChildProcess } from 'node:child_process'\n// 'node:child_process' in a comment\nexport type Child = ChildProcess | typeof import('child_process')\n`)
    await plant('helper.test.ts', `import { execFileSync } from 'node:child_process'\nexport const run = execFileSync\n`)
    await plant('helper.test-util.ts', `import { execFile } from 'node:child_process'\nexport const run = execFile\n`)
    // An allowed module that imports more than spawn.
    const gitModule = join(copy, 'workspace', 'git.ts')
    await writeFile(gitModule, `import { execSync } from 'node:child_process'\n${await readFile(gitModule, 'utf8')}`)

    const { violations } = await checkSpawnGuard(copy)
    expect(violations).toEqual([
      'planted/create-require.ts:2 loads child_process',
      'planted/dynamic.ts:2 loads child_process',
      'planted/reexport.ts:1 loads child_process',
      'planted/required.cjs:1 loads child_process',
      'planted/side-effect.ts:1 loads child_process',
      'planted/static.ts:1 loads child_process',
      'workspace/git.ts:1 imports execSync from child_process (only spawn)',
    ])
  })
})
