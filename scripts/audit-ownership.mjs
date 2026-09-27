#!/usr/bin/env node
// Checks that every changed path in the working tree is owned by exactly one agent of a wave.
//
// Usage: node scripts/audit-ownership.mjs <wave.json>
//
// wave.json: { "wave": "P0.4", "agents": { "C1": ["packages/shared/**"] }, "allow": ["pnpm-lock.yaml"] }
//
// Changed paths come from `git status --porcelain --untracked-files=all` (staged, unstaged and untracked).
// Globs support `**`, `*`, `?` and `{a,b}`; a glob ending with `/` means "everything below this directory".
// Exit code 1 when a changed path matches no owner and no `allow` glob; paths with several owners are
// reported as warnings.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function fail(message) {
  console.error(`audit-ownership: ${message}`)
  process.exit(2)
}

function expandBraces(glob) {
  const open = glob.indexOf('{')
  if (open === -1)
    return [glob]
  const close = glob.indexOf('}', open)
  if (close === -1)
    return [glob]
  const head = glob.slice(0, open)
  const tail = glob.slice(close + 1)
  return glob
    .slice(open + 1, close)
    .split(',')
    .flatMap(alternative => expandBraces(`${head}${alternative}${tail}`))
}

function escapeRegExp(char) {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char
}

function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/'
        if (atSegmentStart && glob[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        }
        else {
          source += '.*'
          i += 1
        }
      }
      else {
        source += '[^/]*'
      }
    }
    else if (char === '?') {
      source += '[^/]'
    }
    else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(`^${source}$`)
}

function compile(globs, label) {
  if (!Array.isArray(globs) || globs.some(glob => typeof glob !== 'string'))
    fail(`${label} must be an array of glob strings`)
  return globs
    .map(glob => glob.trim().replace(/^\.\//, ''))
    .map(glob => (glob.endsWith('/') ? `${glob}**` : glob))
    .flatMap(expandBraces)
    .map(globToRegExp)
}

function changedPaths() {
  const output = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const entries = output.split('\0')
  const paths = new Set()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry)
      continue
    const status = entry.slice(0, 2)
    paths.add(entry.slice(3))
    // Renames and copies are followed by the original path, which also changed.
    if (status.includes('R') || status.includes('C')) {
      i++
      if (entries[i])
        paths.add(entries[i])
    }
  }
  return [...paths].sort()
}

const waveFile = process.argv[2]
if (!waveFile)
  fail('usage: node scripts/audit-ownership.mjs <wave.json>')

let wave
try {
  wave = JSON.parse(readFileSync(resolve(process.cwd(), waveFile), 'utf8'))
}
catch (error) {
  fail(`cannot read ${waveFile}: ${error instanceof Error ? error.message : String(error)}`)
}

if (!wave || typeof wave !== 'object' || !wave.agents || typeof wave.agents !== 'object')
  fail('wave file must look like { "wave": "...", "agents": { "<id>": ["<glob>", ...] }, "allow": ["<glob>"] }')

const owners = Object.entries(wave.agents).map(([id, globs]) => ({ id, patterns: compile(globs, `agents.${id}`) }))
const allowed = compile(wave.allow ?? [], 'allow')

const unowned = []
const shared = []
const byAgent = new Map(owners.map(owner => [owner.id, 0]))
let allowedCount = 0
const paths = changedPaths()

for (const path of paths) {
  const matches = owners.filter(owner => owner.patterns.some(pattern => pattern.test(path))).map(owner => owner.id)
  for (const id of matches)
    byAgent.set(id, (byAgent.get(id) ?? 0) + 1)
  if (matches.length > 1)
    shared.push({ path, matches })
  if (matches.length === 0) {
    if (allowed.some(pattern => pattern.test(path)))
      allowedCount++
    else
      unowned.push(path)
  }
}

console.log(`Ownership audit for wave ${wave.wave ?? '(unnamed)'}: ${paths.length} changed path(s).`)
for (const [id, count] of byAgent)
  console.log(`  ${id}: ${count}`)
if (allowedCount > 0)
  console.log(`  (allowed without owner): ${allowedCount}`)

if (shared.length > 0) {
  console.warn(`\nWARNING: ${shared.length} path(s) match more than one owner:`)
  for (const { path, matches } of shared)
    console.warn(`  ${path}  <-  ${matches.join(', ')}`)
}

if (unowned.length > 0) {
  console.error(`\nERROR: ${unowned.length} changed path(s) are not owned by any agent:`)
  for (const path of unowned)
    console.error(`  ${path}`)
  process.exit(1)
}

console.log('\nOK: every changed path has an owner.')
