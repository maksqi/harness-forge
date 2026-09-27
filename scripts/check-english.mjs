#!/usr/bin/env node
// Fails when any tracked or untracked (non-ignored) text file contains a Cyrillic character.
// Usage: node scripts/check-english.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CYRILLIC = /\p{Script=Cyrillic}/u
const CYRILLIC_GLOBAL = /\p{Script=Cyrillic}/gu
const MAX_EXCERPT = 120

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.icns',
  '.bmp',
  '.tif',
  '.tiff',
  '.psd',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.tar',
  '.jar',
  '.wasm',
  '.node',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.bin',
  '.dat',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mp3',
  '.mp4',
  '.m4a',
  '.wav',
  '.ogg',
  '.webm',
  '.mov',
  '.avi',
])

function listFiles() {
  // Fixed argument list, no shell.
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return [...new Set(output.split('\0').filter(Boolean))].sort()
}

function isBinary(buffer) {
  const length = Math.min(buffer.length, 8192)
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0)
      return true
  }
  return false
}

function excerpt(line) {
  const trimmed = line.trim()
  return trimmed.length > MAX_EXCERPT ? `${trimmed.slice(0, MAX_EXCERPT)}...` : trimmed
}

const findings = []
let scanned = 0

for (const file of listFiles()) {
  if (BINARY_EXTENSIONS.has(extname(file).toLowerCase()))
    continue

  let buffer
  try {
    buffer = readFileSync(resolve(root, file))
  }
  catch {
    // Deleted in the working tree but still in the index, or not a regular file.
    continue
  }
  if (isBinary(buffer))
    continue

  scanned++
  const text = buffer.toString('utf8')
  if (!CYRILLIC.test(text))
    continue

  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    const match = CYRILLIC.exec(line)
    if (!match)
      return
    const count = line.match(CYRILLIC_GLOBAL)?.length ?? 0
    findings.push(`${file}:${index + 1}:${match.index + 1}: ${count} Cyrillic character(s): ${excerpt(line)}`)
  })
}

if (findings.length > 0) {
  console.error(`check:english failed: Cyrillic characters found on ${findings.length} line(s):\n`)
  for (const finding of findings)
    console.error(`  ${finding}`)
  console.error('\nThe repository is English-only (AGENT.md, golden rule 1).')
  process.exit(1)
}

console.log(`check:english passed (${scanned} text files scanned).`)
