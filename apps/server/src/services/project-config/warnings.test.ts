/* eslint-disable no-template-curly-in-string -- `${VAR}` references of `.mcp.json` are part of these fixtures */
// Review warnings of project items (Phase 11, W11.3-T3): the fixed token table of `runs-repository-code`, the
// `private-network` hosts and the order of the warnings.
import type { McpJsonServer } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  argvRunsRepositoryCode,
  commandRunsRepositoryCode,
  commandWarnings,
  INTERPRETERS,
  isPrivateHost,
  mcpServerWarnings,
  programName,
  REPOSITORY_CODE_TOOLS,
  urlIsPrivateNetwork,
} from './warnings.ts'

const MISSING = [{ path: 'scripts/gone.sh', sha256: null }]
const PRESENT = [{ path: 'scripts/ok.sh', sha256: 'a'.repeat(64) }]

function stdio(command: string, args: string[] = []): McpJsonServer {
  return { name: 'local', id: 'local', transport: { type: 'stdio', command, args, env: {} }, raw: { command, args } }
}

function remote(url: string, type: 'http' | 'sse' = 'http'): McpJsonServer {
  return { name: 'remote', id: 'remote', transport: { type, url, headers: {} }, raw: { type, url } }
}

describe('runs-repository-code', () => {
  it('fixes the token table', () => {
    expect([...REPOSITORY_CODE_TOOLS].sort()).toEqual([
      'ant',
      'bazel',
      'bazelisk',
      'bundle',
      'bundler',
      'bunx',
      'cargo',
      'cmake',
      'composer',
      'corepack',
      'dotnet',
      'eslint',
      'gmake',
      'go',
      'gradle',
      'gradlew',
      'hatch',
      'jest',
      'just',
      'lerna',
      'make',
      'meson',
      'mix',
      'mocha',
      'mvn',
      'mvnw',
      'ninja',
      'nox',
      'npm',
      'npx',
      'nx',
      'pdm',
      'pipenv',
      'pipx',
      'playwright',
      'pnpm',
      'pnpx',
      'poetry',
      'prettier',
      'pytest',
      'rake',
      'sbt',
      'scons',
      'stylelint',
      'task',
      'tox',
      'turbo',
      'uv',
      'uvx',
      'vitest',
      'yarn',
      'yarnpkg',
    ])
    expect([...INTERPRETERS].sort()).toEqual(['bun', 'deno', 'lua', 'node', 'nodejs', 'perl', 'php', 'py', 'pypy', 'pypy3', 'python', 'python3', 'rscript', 'ruby', 'ts-node', 'tsx'])
  })

  it.each([
    ['npm test', true],
    ['pnpm -s lint && echo done', true],
    ['npx prettier --write .', true],
    ['make check', true],
    ['./gradlew build', true],
    ['CI=1 NODE_ENV=test npm run lint', true],
    ['env -i PATH=/usr/bin make', true],
    ['timeout 10 cargo test', true],
    ['"$CLAUDE_PROJECT_DIR"/node_modules/.bin/eslint --fix', true],
    ['cd sub && yarn build', true],
    ['node scripts/check.mjs', true],
    ['python3 -m pytest', true],
    ['python3 .claude/hooks/check.py', true],
    ['sh -c "npm test"', true],
    ['sh .claude/hooks/check.sh', false],
    ['"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh', false],
    ['echo hello | tee log.txt', false],
    ['node -e "console.log(1)"', false],
    ['python3 -c "print(1)"', false],
    ['node --version', false],
    ['git status --short', false],
    ['', false],
  ])('%s -> %s', (command, expected) => {
    expect(commandRunsRepositoryCode(command)).toBe(expected)
  })

  it('reads argument lists and program names', () => {
    expect(argvRunsRepositoryCode(['npx', '-y', '@modelcontextprotocol/server-memory'])).toBe(true)
    expect(argvRunsRepositoryCode(['/usr/local/bin/node', 'server.mjs'])).toBe(true)
    expect(argvRunsRepositoryCode(['uvx', 'mcp-server-git'])).toBe(true)
    expect(argvRunsRepositoryCode(['bash', '-c', 'make serve'])).toBe(true)
    expect(argvRunsRepositoryCode(['./bin/server'])).toBe(false)
    expect(argvRunsRepositoryCode([])).toBe(false)
    expect(programName('"C:/tools/NPM.CMD"')).toBe('npm')
    expect(programName('./gradlew')).toBe('gradlew')
  })
})

describe('private-network', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST.', true],
    ['127.0.0.1', true],
    ['[::1]', true],
    ['10.1.2.3', true],
    ['192.168.0.10', true],
    ['169.254.169.254', true],
    ['mcp.localhost', true],
    ['printer.local', true],
    ['db.internal', true],
    ['router.home.arpa', true],
    ['mcp-box', true],
    ['example.com', false],
    ['8.8.8.8', false],
    ['mcp.example.invalid', false],
  ])('%s -> %s', (host, expected) => {
    expect(isPrivateHost(host.replace(/^\[|\]$/g, ''))).toBe(expected)
  })

  it('reads URLs with ${VAR:-default} defaults; a host from a variable without a default is unknown', () => {
    expect(urlIsPrivateNetwork('http://127.0.0.1:9/mcp')).toBe(true)
    expect(urlIsPrivateNetwork('http://2130706433/mcp')).toBe(true)
    expect(urlIsPrivateNetwork('https://api.example.com/mcp')).toBe(false)
    expect(urlIsPrivateNetwork('http://localhost:${MCP_PORT:-9}/mcp')).toBe(true)
    expect(urlIsPrivateNetwork('${BASE:-http://10.0.0.5}/mcp')).toBe(true)
    expect(urlIsPrivateNetwork('${BASE}/mcp')).toBe(false)
    expect(urlIsPrivateNetwork('not a url')).toBe(false)
  })
})

describe('warnings of an item', () => {
  it('lists the warnings in schema order without duplicates', () => {
    expect(commandWarnings(['npm test', 'make'], MISSING)).toEqual(['referenced-file-missing', 'runs-repository-code'])
    expect(commandWarnings(['sh scripts/ok.sh'], PRESENT)).toEqual([])
    expect(mcpServerWarnings(remote('http://localhost:${MCP_PORT:-9}/mcp', 'sse'), [])).toEqual(['private-network'])
    expect(mcpServerWarnings(remote('https://mcp.example.com/'), [])).toEqual([])
    expect(mcpServerWarnings(stdio('npx', ['-y', 'server']), MISSING)).toEqual(['referenced-file-missing', 'runs-repository-code'])
    expect(mcpServerWarnings(stdio('./bin/server'), PRESENT)).toEqual([])
  })
})
