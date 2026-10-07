// SEC-A5 (ADR-017, API.md "fresh"): with a password set, every sensitive operation needs a password login within the
// last 10 minutes, else `403 forbidden` with `action: 'login'` and nothing changes. Route-table driven: the cases below
// must cover every route flagged `fresh` in the shared route table plus the conditional cases the server enforces
// (installing / trusting code or stdio-MCP plugins, scaffold, code-file writes and deletes, build, reload of code
// plugins, stdio MCP create / update, drafts that declare a stdio server, password change, adding a project, rotating
// the master key; Phase 11: creating a personal hook, changing one unless the body only turns it off, approving project
// items, setting project MCP variables; Phase 12: scanning the server's Claude Code folder, applying an import). Each
// case runs twice on a
// fresh app: with a stale session (refused, no side effect), then with a fresh one (succeeds). Negative controls show
// that the same routes stay usable with a stale session when nothing runs code.
import type { ApiRouteDef, ApiRouteKey } from '@harness-forge/shared'
import type { FileSet, InstallTestApp } from '../plugins/install/testing.ts'
import { existsSync, readdirSync } from 'node:fs'
import { API_ROUTE_KEYS, apiRoutes, harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { FRESH_AUTH_REQUIRED_MESSAGE } from '../http/middleware/fresh-auth.ts'
import { SESSION_COOKIE_NAME } from '../http/middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../http/types.ts'
import { stubRouteKeys } from '../http/validate.ts'
import {
  allowAll,
  codePlugin,
  createInstallTestApp,
  declarativePlugin,
  manifestOf,
  removeTempDirs,
  setupRuns,
  stdioPlugin,
  zipOf,
} from '../plugins/install/testing.ts'
import { sampleRequest } from '../testing/api-samples.ts'

const PASSWORD = 'correct horse battery staple'
const NO_CHECK = { requireFreshAuth: () => {} }
/** Chats prepared for the bulk data and share cases. */
const DATA_CHAT_ID = '0199a8f0-0000-7000-8000-00000000da7a'
const SHARE_CHAT_ID = '0199a8f0-0000-7000-8000-00000000517e'

/** Routes that the server checks conditionally (`ApiRouteDef.fresh` documents them; ADR-017). */
const CONDITIONAL_FRESH_KEYS: readonly ApiRouteKey[] = [
  'pluginInstall.install',
  'plugins.reload',
  'pluginFiles.write',
  'pluginFiles.remove',
  'mcp.create',
  'mcp.update',
  'pluginDrafts.create',
  'pluginDrafts.updateManifest',
  // Phase 11 (ADR-048): unless the body only turns the hook off (`{ enabled: false }`).
  'hooks.update',
]
const ALWAYS_FRESH_KEYS = API_ROUTE_KEYS.filter(key => (apiRoutes[key] as ApiRouteDef).fresh === true)

let app: InstallTestApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
  removeTempDirs()
})

interface Attempt {
  method: string
  path: string
  /** JSON body, or a multipart form built per attempt. */
  json?: unknown
  form?: () => FormData
}

interface FreshCase {
  name: string
  key: ApiRouteKey
  /** Prepares the state (services called directly, so no fresh auth is involved). */
  prepare?: (a: InstallTestApp) => Promise<void>
  attempt: Attempt
  /**
   * Status of the fresh attempt, or the statuses it may have (a route that is still a stub answers 501 from its own
   * handler instead).
   */
  ok: number | readonly number[]
  /** Proves the refused attempt changed nothing. */
  unchanged: (a: InstallTestApp) => Promise<void>
}

function form(files: FileSet, fields: Record<string, string> = {}): () => FormData {
  return () => {
    const body = new FormData()
    body.append('file', new Blob([zipOf(files)]), 'plugin.zip')
    for (const [key, value] of Object.entries(fields))
      body.append(key, value)
    return body
  }
}

const STDIO: { type: 'stdio', command: string, args: string[] } = { type: 'stdio', command: 'node', args: ['server.mjs'] }

function stdioManifest(id: string): Record<string, unknown> {
  return JSON.parse(manifestOf(id, {
    contributes: { mcpServers: [{ id: `${id}-srv`, name: 'Local tools', transport: STDIO }] },
  })) as Record<string, unknown>
}

async function scaffoldCode(a: InstallTestApp, id: string): Promise<void> {
  await a.t.deps.pluginFiles.scaffold({ id, name: `Plugin ${id}`, template: 'tool' })
}

async function fileContent(a: InstallTestApp, id: string, path: string): Promise<string | null> {
  try {
    return (await a.t.deps.pluginFiles.read(id, path)).content
  }
  catch {
    return null
  }
}

const CASES: FreshCase[] = [
  {
    name: 'changing the password',
    key: 'auth.setPassword',
    attempt: { method: 'PUT', path: '/api/auth/password', json: { currentPassword: PASSWORD, newPassword: 'another password 42' } },
    ok: 200,
    unchanged: async a => expect(await a.t.deps.passwords.check(PASSWORD)).toBe(true),
  },
  {
    name: 'installing a code plugin (with trust)',
    key: 'pluginInstall.install',
    attempt: { method: 'POST', path: '/api/plugins/install', form: form(codePlugin('fresh-code'), { trust: 'true' }) },
    ok: 201,
    unchanged: async (a) => {
      expect(await a.t.deps.plugins.record('fresh-code')).toBeNull()
      expect(setupRuns('fresh-code')).toBe(0)
    },
  },
  {
    name: 'installing a code plugin without trust (it stays inert, but runs code once trusted)',
    key: 'pluginInstall.install',
    attempt: { method: 'POST', path: '/api/plugins/install', form: form(codePlugin('fresh-untrusted')) },
    ok: 201,
    unchanged: async a => expect(await a.t.deps.plugins.record('fresh-untrusted')).toBeNull(),
  },
  {
    name: 'installing a declarative plugin with a stdio MCP server',
    key: 'pluginInstall.install',
    attempt: { method: 'POST', path: '/api/plugins/install', form: form(stdioPlugin('fresh-stdio')) },
    ok: 201,
    unchanged: async a => expect(await a.t.deps.plugins.record('fresh-stdio')).toBeNull(),
  },
  {
    name: 'trusting a plugin',
    key: 'pluginInstall.trust',
    prepare: async (a) => {
      await a.t.deps.installer.install({ source: 'zip', fileName: 'p.zip', data: zipOf(codePlugin('fresh-trust')) }, { authorize: allowAll })
    },
    attempt: { method: 'POST', path: '/api/plugins/fresh-trust/trust', json: 'hash-of:fresh-trust' },
    ok: 200,
    unchanged: async (a) => {
      expect((await a.t.deps.plugins.get('fresh-trust')).trust.trusted).toBe(false)
      expect(setupRuns('fresh-trust')).toBe(0)
    },
  },
  {
    name: 'scaffolding a code plugin',
    key: 'pluginFiles.scaffold',
    attempt: { method: 'POST', path: '/api/plugins/scaffold', json: { id: 'fresh-scaffold', name: 'Scaffold', template: 'tool' } },
    ok: 201,
    unchanged: async a => expect(await a.t.deps.plugins.record('fresh-scaffold')).toBeNull(),
  },
  {
    name: 'writing a file of a code plugin',
    key: 'pluginFiles.write',
    prepare: a => scaffoldCode(a, 'fresh-write'),
    attempt: { method: 'PUT', path: '/api/plugins/fresh-write/files/index.mjs', json: { content: 'export default { setup() {} }\n' } },
    ok: 200,
    unchanged: async a => expect(await fileContent(a, 'fresh-write', 'index.mjs')).not.toBe('export default { setup() {} }\n'),
  },
  {
    name: 'turning a declarative plugin into a code plugin (plugin.json with main)',
    key: 'pluginFiles.write',
    prepare: async (a) => {
      await a.t.deps.drafts.create({ manifest: JSON.parse(manifestOf('fresh-to-code')) as never }, NO_CHECK)
      await a.t.deps.pluginFiles.write('fresh-to-code', 'index.mjs', { content: 'export default { setup() {} }\n' }, NO_CHECK)
    },
    attempt: { method: 'PUT', path: '/api/plugins/fresh-to-code/files/plugin.json', json: { content: manifestOf('fresh-to-code', { main: 'index.mjs' }) } },
    ok: 200,
    unchanged: async a => expect((await a.t.deps.plugins.get('fresh-to-code')).kind).toBe('declarative'),
  },
  {
    name: 'deleting a file of a code plugin',
    key: 'pluginFiles.remove',
    prepare: async (a) => {
      await scaffoldCode(a, 'fresh-delete')
      await a.t.deps.pluginFiles.write('fresh-delete', 'lib/extra.mjs', { content: 'export const x = 1\n' }, NO_CHECK)
    },
    attempt: { method: 'DELETE', path: '/api/plugins/fresh-delete/files/lib/extra.mjs' },
    ok: 204,
    unchanged: async a => expect(await fileContent(a, 'fresh-delete', 'lib/extra.mjs')).toBe('export const x = 1\n'),
  },
  {
    name: 'building a code plugin',
    key: 'pluginFiles.build',
    prepare: a => scaffoldCode(a, 'fresh-build'),
    attempt: { method: 'POST', path: '/api/plugins/fresh-build/build', json: { reload: true } },
    ok: 200,
    unchanged: async () => {},
  },
  {
    name: 'reloading a code plugin',
    key: 'plugins.reload',
    prepare: a => scaffoldCode(a, 'fresh-reload'),
    attempt: { method: 'POST', path: '/api/plugins/fresh-reload/reload' },
    ok: 200,
    unchanged: async () => {},
  },
  {
    name: 'creating a stdio MCP server',
    key: 'mcp.create',
    attempt: { method: 'POST', path: '/api/mcp', json: { id: 'fresh-mcp', name: 'Local', enabled: false, transport: STDIO } },
    ok: 201,
    unchanged: async a => expect((await a.t.deps.mcp.list()).map(server => server.id)).not.toContain('fresh-mcp'),
  },
  {
    name: 'switching an MCP server to stdio',
    key: 'mcp.update',
    prepare: async (a) => {
      await a.t.deps.mcp.create({ id: 'fresh-switch', name: 'Web', enabled: false, transport: { type: 'http', url: 'https://mcp.example.com/mcp' } })
    },
    attempt: { method: 'PATCH', path: '/api/mcp/fresh-switch', json: { transport: STDIO } },
    ok: 200,
    unchanged: async a => expect((await a.t.deps.mcp.get('fresh-switch')).transport.type).toBe('http'),
  },
  {
    name: 'changing the command of a stdio MCP server',
    key: 'mcp.update',
    prepare: async (a) => {
      await a.t.deps.mcp.create({ id: 'fresh-command', name: 'Local', enabled: false, transport: STDIO }, NO_CHECK)
    },
    attempt: { method: 'PATCH', path: '/api/mcp/fresh-command', json: { transport: { ...STDIO, args: ['other.mjs'] } } },
    ok: 200,
    unchanged: async (a) => {
      const server = await a.t.deps.mcp.get('fresh-command')
      expect(server.transport.type === 'stdio' ? server.transport.args : null).toEqual(['server.mjs'])
    },
  },
  {
    name: 'creating a declarative plugin with a stdio MCP server',
    key: 'pluginDrafts.create',
    attempt: { method: 'POST', path: '/api/plugins', json: { manifest: stdioManifest('fresh-draft') } },
    ok: 201,
    unchanged: async a => expect(await a.t.deps.plugins.record('fresh-draft')).toBeNull(),
  },
  {
    name: 'adding a stdio MCP server to a created plugin',
    key: 'pluginDrafts.updateManifest',
    prepare: async (a) => {
      await a.t.deps.drafts.create({ manifest: JSON.parse(manifestOf('fresh-manifest')) as never }, NO_CHECK)
    },
    attempt: { method: 'PUT', path: '/api/plugins/fresh-manifest/manifest', json: { manifest: stdioManifest('fresh-manifest') } },
    ok: 200,
    unchanged: async a => expect((await a.t.deps.plugins.get('fresh-manifest')).trust.required).toBe(false),
  },
  {
    name: 'deleting all data',
    key: 'data.deleteAll',
    prepare: async (a) => {
      await a.t.deps.chats.create({ id: DATA_CHAT_ID, title: 'Keep me' })
    },
    attempt: { method: 'POST', path: '/api/data/delete', json: { confirm: 'DELETE', files: true, usage: true } },
    ok: 200,
    unchanged: async a => expect(await a.t.deps.chats.find(DATA_CHAT_ID)).not.toBeNull(),
  },
  {
    name: 'publishing a share link',
    key: 'shares.create',
    prepare: async (a) => {
      await a.t.deps.chats.create({
        id: SHARE_CHAT_ID,
        title: 'Shared',
        messages: [{ id: 'msg_share00000000001', role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1 }, parts: [{ type: 'text', text: 'Hello' }] }],
      })
    },
    attempt: { method: 'POST', path: '/api/shares', json: { chatId: SHARE_CHAT_ID } },
    ok: 201,
    // Share rows are checked by the shares route tests; a refused request never reaches the service.
    unchanged: async () => {},
  },
  {
    name: 'changing a share link (the unknown share proves the request reached the route)',
    key: 'shares.update',
    attempt: { method: 'PATCH', path: '/api/shares/shr_fresh00000000001', json: { refresh: true } },
    ok: 404,
    unchanged: async () => {},
  },
  {
    // ADR-031: a project gives the session file and shell access to a folder. The missing folder proves the request
    // reached the route (404) without creating anything.
    name: 'adding a project (a missing folder proves the request reached the route)',
    key: 'projects.create',
    attempt: { method: 'POST', path: '/api/projects', json: { name: 'Fresh project', path: '/harness-forge-fresh/missing', newFolder: 'fresh-project' } },
    ok: 404,
    unchanged: async () => {},
  },
  {
    // ADR-034: the test app's key comes from no HF_MASTER_KEY (file mode), so the online rotation runs (200).
    name: 'rotating the master key',
    key: 'keys.rotate',
    attempt: { method: 'POST', path: '/api/keys/rotate', json: { confirm: 'ROTATE' } },
    ok: 200,
    unchanged: async (a) => {
      expect(a.t.deps.keyring.keyVersion).toBe(1)
      expect(existsSync(`${a.t.env.paths.secretKey}.next`)).toBe(false)
    },
  },
  {
    // ADR-048: a personal hook runs a shell command at every matching event.
    name: 'creating a personal hook',
    key: 'hooks.create',
    attempt: { method: 'POST', path: '/api/hooks', json: { event: 'PostToolUse', command: 'sh .claude/hooks/format.sh', timeout: 30 } },
    ok: 201,
    unchanged: async () => {},
  },
  {
    // ADR-048: a new command changes what runs (turning a hook off needs no fresh auth, see the negative controls). The
    // unknown hook proves the request reached the route.
    name: 'changing the command of a personal hook (an unknown hook proves the request reached the route)',
    key: 'hooks.update',
    attempt: { method: 'PATCH', path: '/api/hooks/hok_fresh00000000001', json: { command: 'sh .claude/hooks/lint.sh' } },
    ok: 404,
    unchanged: async () => {},
  },
  {
    // ADR-049: an approval lets repository content run. The unknown project proves the request reached the route.
    name: 'approving project items (an unknown project proves the request reached the route)',
    key: 'projectTrust.approve',
    attempt: { method: 'POST', path: '/api/projects/prj_fresh00000000001/trust', json: { items: [{ kind: 'hook', sha256: 'a'.repeat(64) }] } },
    ok: 404,
    unchanged: async () => {},
  },
  {
    // ADR-050: a variable can change what an approved stdio server runs.
    name: 'setting project MCP variables (an unknown project proves the request reached the route)',
    key: 'projectMcp.setVariables',
    attempt: { method: 'PUT', path: '/api/projects/prj_fresh00000000001/mcp/variables', json: { values: { MCP_TOKEN: 'fresh-token' } } },
    ok: 404,
    unchanged: async () => {},
  },
  {
    // ADR-055: the scan reads the server user's Claude Code folder (the test app's `HF_CLAUDE_HOME` decides whether it
    // plans, answers `404` for a missing folder (the test app's default, never created) or `409` `disabled`).
    name: 'scanning the server\'s Claude Code folder',
    key: 'claudeImport.scan',
    attempt: { method: 'POST', path: '/api/claude-import/scan' },
    ok: [200, 404, 409],
    unchanged: async () => {},
  },
  {
    // ADR-055: applying creates personal hooks, stdio MCP servers and shell rules. The unknown plan proves the request
    // reached the route.
    name: 'applying an import (an unknown plan proves the request reached the route)',
    key: 'claudeImport.apply',
    attempt: { method: 'POST', path: '/api/claude-import/apply', json: { planId: 'cip_fresh00000000001', items: [{ key: 'hook:Stop:settings.json', action: 'import', enable: true }] } },
    ok: 404,
    unchanged: async () => {},
  },
]

async function cookie(a: InstallTestApp, authAgeMs: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await a.t.deps.sessions.issue({ authAt: Date.now() - authAgeMs })}`
}

async function send(a: InstallTestApp, attempt: Attempt, sessionCookie: string): Promise<Response> {
  const headers: Record<string, string> = { cookie: sessionCookie }
  let body: RequestInit['body']
  if (attempt.form !== undefined) {
    body = attempt.form()
  }
  else if (attempt.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(attempt.json)
  }
  return a.t.request(attempt.path, { method: attempt.method, headers, ...(body === undefined ? {} : { body }) })
}

/** Resolves `hash-of:<id>` bodies (the trust body needs the current hash of a plugin prepared in the same case). */
async function resolveAttempt(a: InstallTestApp, attempt: Attempt): Promise<Attempt> {
  if (typeof attempt.json === 'string' && attempt.json.startsWith('hash-of:')) {
    const detail = await a.t.deps.plugins.get(attempt.json.slice('hash-of:'.length))
    return { ...attempt, json: { sha256: detail.trust.hash } }
  }
  return attempt
}

async function passwordApp(): Promise<InstallTestApp> {
  app = await createInstallTestApp()
  // A stored password (source `settings`), so changing it succeeds with a fresh session.
  await app.t.deps.passwords.set(PASSWORD)
  return app
}

describe('sEC-A5 fresh auth table', () => {
  it('covers every fresh route of the route table and every conditional case of ADR-017', () => {
    const covered = new Set(CASES.map(entry => entry.key))
    for (const key of [...ALWAYS_FRESH_KEYS, ...CONDITIONAL_FRESH_KEYS])
      expect(covered.has(key), key).toBe(true)
    expect([...ALWAYS_FRESH_KEYS].sort()).toEqual([
      'auth.setPassword',
      'claudeImport.apply',
      'claudeImport.scan',
      'data.deleteAll',
      'hooks.create',
      'keys.rotate',
      'pluginFiles.build',
      'pluginFiles.scaffold',
      'pluginInstall.trust',
      'projectMcp.setVariables',
      'projectTrust.approve',
      'projects.create',
      'shares.create',
      'shares.update',
    ])
  })

  it.each(CASES)('$key: $name', async (entry) => {
    const a = await passwordApp()
    await entry.prepare?.(a)
    const attempt = await resolveAttempt(a, entry.attempt)

    const stale = await send(a, attempt, await cookie(a, FRESH_AUTH_WINDOW_MS + 60_000))
    expect(stale.status).toBe(403)
    expect(harnessErrorEnvelopeSchema.parse(await stale.json()).error).toEqual({ code: 'forbidden', message: FRESH_AUTH_REQUIRED_MESSAGE, action: 'login' })
    await entry.unchanged(a)
    expect(readdirSync(a.stagingDir)).toEqual([])

    const fresh = await send(a, attempt, await cookie(a, 60_000))
    const text = await fresh.text()
    const expected = stubRouteKeys().has(entry.key) ? [501] : typeof entry.ok === 'number' ? [entry.ok] : entry.ok
    expect(expected, text).toContain(fresh.status)
  })

  it('the window is 10 minutes from the password login (inclusive)', async () => {
    const a = await passwordApp()
    const attempt: Attempt = { method: 'POST', path: '/api/plugins/scaffold', json: { id: 'fresh-edge', name: 'Edge', template: 'tool' } }
    expect((await send(a, attempt, await cookie(a, FRESH_AUTH_WINDOW_MS + 2000))).status).toBe(403)
    expect((await send(a, attempt, await cookie(a, FRESH_AUTH_WINDOW_MS - 5000))).status).toBe(201)
  })
})

describe('sEC-A5 negative controls: nothing runs code, a stale session is enough', () => {
  it('declarative installs, declarative file writes and reloads, and HTTP MCP servers', async () => {
    const a = await passwordApp()
    const stale = await cookie(a, FRESH_AUTH_WINDOW_MS + 60_000)
    expect((await send(a, { method: 'POST', path: '/api/plugins/install', form: form(declarativePlugin('stale-ok')) }, stale)).status).toBe(201)
    await a.t.deps.drafts.create({ manifest: JSON.parse(manifestOf('stale-created')) as never }, NO_CHECK)
    expect((await send(a, { method: 'PUT', path: '/api/plugins/stale-created/files/notes.md', json: { content: 'notes\n' } }, stale)).status).toBe(200)
    expect((await send(a, { method: 'POST', path: '/api/plugins/stale-created/reload' }, stale)).status).toBe(200)
    expect((await send(a, { method: 'POST', path: '/api/mcp', json: { id: 'stale-web', name: 'Web', enabled: false, transport: { type: 'http', url: 'https://mcp.example.com/mcp' } } }, stale)).status).toBe(201)
    expect((await send(a, { method: 'POST', path: '/api/plugins/inspect', form: form(codePlugin('stale-inspect')) }, stale)).status).toBe(200)
  })

  it('the change routes and the shell rules (Phase 8, ADR-036 … ADR-038) take a stale session', async () => {
    const a = await passwordApp()
    const stale = await cookie(a, FRESH_AUTH_WINDOW_MS + 60_000)
    const keys = API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'changes' || apiRoutes[key].module === 'shellRules')
    expect(keys).toHaveLength(10)
    for (const key of keys) {
      const { path, init } = sampleRequest(key, { headers: { cookie: stale } })
      const response = await a.t.request(path, init)
      const text = await response.text()
      // The sample chat, project and rule do not exist: the request reaches the route (501 while stubbed, else 404 or
      // 200), never the fresh-auth refusal.
      expect([401, 403], `${key}: ${text}`).not.toContain(response.status)
      if (stubRouteKeys().has(key))
        expect(response.status, key).toBe(501)
    }
  })

  it('the steer queue and the file mentions (Phase 9, ADR-042) take a stale session', async () => {
    const a = await passwordApp()
    const stale = await cookie(a, FRESH_AUTH_WINDOW_MS + 60_000)
    const keys = API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'chatQueue' || apiRoutes[key].module === 'projectFiles')
    expect(keys).toHaveLength(5)
    for (const key of keys) {
      const { path, init } = sampleRequest(key, { headers: { cookie: stale } })
      const response = await a.t.request(path, init)
      const text = await response.text()
      // The sample chat and project do not exist: the request reaches the route (501 while stubbed, else 404 or 409),
      // never the fresh-auth refusal.
      expect([401, 403], `${key}: ${text}`).not.toContain(response.status)
      if (stubRouteKeys().has(key))
        expect(response.status, key).toBe(501)
    }
  })

  it('the customizations, Remember and the background tasks (Phase 10, ADR-044 … ADR-047) take a stale session', async () => {
    const a = await passwordApp()
    const stale = await cookie(a, FRESH_AUTH_WINDOW_MS + 60_000)
    const keys = API_ROUTE_KEYS.filter(key => ['customizations', 'memory', 'chatTasks'].includes(apiRoutes[key].module))
    expect(keys).toHaveLength(9)
    for (const key of keys) {
      const { path, init } = sampleRequest(key, { headers: { cookie: stale } })
      const response = await a.t.request(path, init)
      const text = await response.text()
      // The sample chat, project, definition and task do not exist: the request reaches the route (501 while stubbed,
      // else 404, 400 or 409), never the fresh-auth refusal.
      expect([401, 403], `${key}: ${text}`).not.toContain(response.status)
      if (stubRouteKeys().has(key))
        expect(response.status, key).toBe(501)
    }
  })

  it('the hook, project trust and project MCP routes (Phase 11, ADR-048 … ADR-050) other than the fresh ones take a stale session', async () => {
    const a = await passwordApp()
    const stale = await cookie(a, FRESH_AUTH_WINDOW_MS + 60_000)
    const phase11 = API_ROUTE_KEYS.filter(key => ['hooks', 'projectTrust', 'projectMcp'].includes(apiRoutes[key].module))
    expect(phase11).toHaveLength(11)
    const keys = phase11.filter(key => (apiRoutes[key] as ApiRouteDef).fresh !== true && key !== 'hooks.update')
    expect(keys).toEqual(['hooks.list', 'hooks.runs', 'hooks.remove', 'projectTrust.list', 'projectTrust.revoke', 'projectMcp.list', 'projectMcp.reconnect'])
    for (const key of keys) {
      const { path, init } = sampleRequest(key, { headers: { cookie: stale } })
      const response = await a.t.request(path, init)
      const text = await response.text()
      // The sample project, hook and server do not exist: the request reaches the route (501 while stubbed, else 404 or
      // 200), never the fresh-auth refusal.
      expect([401, 403], `${key}: ${text}`).not.toContain(response.status)
      if (stubRouteKeys().has(key))
        expect(response.status, key).toBe(501)
    }
    // Turning a hook off needs no fresh auth (any other change does: the fresh auth table above).
    const off = await send(a, { method: 'PATCH', path: '/api/hooks/hok_stale00000000001', json: { enabled: false } }, stale)
    expect([401, 403], await off.text()).not.toContain(off.status)
    if (stubRouteKeys().has('hooks.update'))
      expect(off.status).toBe(501)
    for (const json of [{ enabled: true }, { enabled: false, timeout: 5 }]) {
      const refused = await send(a, { method: 'PATCH', path: '/api/hooks/hok_stale00000000001', json }, stale)
      expect(refused.status, JSON.stringify(json)).toBe(403)
    }
  })

  it('the marketplace, import and project definition routes (Phase 12, ADR-054 … ADR-056) other than scan and apply take a stale session', async () => {
    const a = await passwordApp()
    const stale = await cookie(a, FRESH_AUTH_WINDOW_MS + 60_000)
    const phase12 = API_ROUTE_KEYS.filter(key => ['marketplaces', 'claudeImport', 'projectDefinitions'].includes(apiRoutes[key].module))
    expect(phase12).toHaveLength(12)
    const keys = phase12.filter(key => (apiRoutes[key] as ApiRouteDef).fresh !== true)
    expect(keys).toEqual([
      'marketplaces.list',
      'marketplaces.add',
      'marketplaces.get',
      'marketplaces.refresh',
      'marketplaces.remove',
      'claudeImport.home',
      'claudeImport.upload',
      'projectDefinitions.read',
      'projectDefinitions.write',
      'projectDefinitions.remove',
    ])
    for (const key of keys) {
      const { path, init } = sampleRequest(key, { headers: { cookie: stale } })
      const response = await a.t.request(path, init)
      const text = await response.text()
      // The sample marketplace folder, project and definition do not exist: the request reaches the route (501 while
      // stubbed, else 200, 400, 404 or 409), never the fresh-auth refusal (saving a project file approves nothing).
      expect([401, 403], `${key}: ${text}`).not.toContain(response.status)
      if (stubRouteKeys().has(key))
        expect(response.status, key).toBe(501)
    }
  })
})
