import type { ApiRouteDef, ApiRouteKey } from './routes.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { API_MODULES, API_ROUTE_KEYS, apiRoutes, isJsonResponse, matchApiRoute, routeSuccessStatus } from './routes.ts'

const API_MD = readFileSync(new URL('../../../../docs/API.md', import.meta.url), 'utf8')
const DECISIONS_MD = readFileSync(new URL('../../../../docs/DECISIONS.md', import.meta.url), 'utf8')

interface DocRoute {
  key: string
  method: string
  path: string
  module: string
  flags: string
}

function camelCase(file: string): string {
  return file.replace(/\.ts$/, '').replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function stripQuery(path: string): string {
  return path.replace(/\?.*$/, '')
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading)
  expect(start, `heading "${heading}"`).toBeGreaterThanOrEqual(0)
  const next = markdown.indexOf('\n## ', start + heading.length)
  return markdown.slice(start, next < 0 ? undefined : next)
}

/** Rows of the route key index (API.md section 8). */
function routeIndex(): DocRoute[] {
  const rows: DocRoute[] = []
  for (const line of section(API_MD, '## 8. Route key index').split('\n')) {
    const match = line.match(/^\| `([\w.]+)` \| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|/)
    if (!match)
      continue
    const [, key = '', method = '', path = ''] = match
    const cells = line.split('|')
    const flags = cells[cells.length - 2] ?? ''
    rows.push({ key, method, path, module: key.split('.')[0] ?? '', flags: flags.trim() })
  }
  return rows
}

/** Endpoint headings of API.md section 5, grouped by route module file. */
function endpointSections(): DocRoute[] {
  const rows: DocRoute[] = []
  let module = ''
  for (const line of section(API_MD, '## 5. Endpoints').split('\n')) {
    const heading = line.match(/^### 5\.\d+ `([\w-]+\.ts)`/)
    if (heading) {
      module = camelCase(heading[1] ?? '')
      continue
    }
    const endpoint = line.match(/^\*\*`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`\*\* — `([\w.]+)`(.*)$/)
    if (endpoint) {
      const [, method = '', path = '', key = '', flags = ''] = endpoint
      rows.push({ key, method, path: stripQuery(path), module, flags })
    }
  }
  return rows
}

/** The route-module table of DECISIONS.md ("HTTP API"). */
function decisionsTable(): DocRoute[] {
  const rows: DocRoute[] = []
  for (const line of section(DECISIONS_MD, '### HTTP API').split('\n')) {
    const match = line.match(/^\| `([\w-]+\.ts)` \| (.+) \|$/)
    if (!match)
      continue
    const module = camelCase(match[1] ?? '')
    for (const endpoint of (match[2] ?? '').matchAll(/`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`/g))
      rows.push({ key: '', method: endpoint[1] ?? '', path: stripQuery((endpoint[2] ?? '').replace(/\s*\(.*\)$/, '')), module, flags: '' })
  }
  return rows
}

function signature(route: { method: string, path: string, module: string }): string {
  return `${route.method} ${route.path} ${route.module}`
}

function tableSignatures(): string[] {
  return API_ROUTE_KEYS.map((key) => {
    const route: ApiRouteDef = apiRoutes[key]
    return signature(route)
  }).sort()
}

describe('route table', () => {
  it('has 85 routes keyed <module>.<action>', () => {
    expect(API_ROUTE_KEYS).toHaveLength(85)
    for (const key of API_ROUTE_KEYS) {
      const route: ApiRouteDef = apiRoutes[key]
      expect(key.startsWith(`${route.module}.`), key).toBe(true)
      expect(API_MODULES).toContain(route.module)
    }
    expect(new Set(API_ROUTE_KEYS.map(key => apiRoutes[key].module))).toEqual(new Set(API_MODULES))
  })

  it('has a unique method + path per route', () => {
    const seen = new Set(API_ROUTE_KEYS.map(key => `${apiRoutes[key].method} ${apiRoutes[key].path}`))
    expect(seen.size).toBe(API_ROUTE_KEYS.length)
  })

  it('equals the route key index of API.md (key, method, path, module)', () => {
    const index = routeIndex()
    expect(index).toHaveLength(85)
    expect(index.map(row => `${row.key} ${signature(row)}`).sort()).toEqual(
      API_ROUTE_KEYS.map(key => `${key} ${signature(apiRoutes[key])}`).sort(),
    )
  })

  it('equals the endpoint sections of API.md (method, path, module)', () => {
    const sections = endpointSections()
    expect(sections.map(signature).sort()).toEqual(tableSignatures())
    for (const row of sections)
      expect(row.module, row.key).toBe(row.key.split('.')[0])
  })

  it('equals the route-module table of DECISIONS.md (method, path, module)', () => {
    expect(decisionsTable().map(signature).sort()).toEqual(tableSignatures())
  })

  it('carries the public, fresh and 201 flags of the API.md index', () => {
    for (const row of routeIndex()) {
      const route: ApiRouteDef = apiRoutes[row.key as ApiRouteKey]
      const flags = row.flags.split(',').map(flag => flag.trim()).filter(Boolean)
      expect(route.public === true, `${row.key} public`).toBe(flags.includes('public'))
      expect(route.fresh === true, `${row.key} fresh`).toBe(flags.includes('fresh'))
      expect(route.status === 201, `${row.key} 201`).toBe(flags.includes('201'))
    }
  })

  it('declares params exactly for the path placeholders', () => {
    for (const key of API_ROUTE_KEYS) {
      const route: ApiRouteDef = apiRoutes[key]
      const names = route.path.split('/').filter(part => part.startsWith(':') || part === '*').map(part => (part === '*' ? 'path' : part.slice(1)))
      if (names.length === 0) {
        expect(route.params, key).toBeUndefined()
        continue
      }
      expect(route.params, key).toBeInstanceOf(z.ZodObject)
      expect(Object.keys((route.params as z.ZodObject).shape).sort(), key).toEqual(names.sort())
    }
  })

  it('uses 204 exactly for empty responses', () => {
    for (const key of API_ROUTE_KEYS) {
      const route: ApiRouteDef = apiRoutes[key]
      expect(routeSuccessStatus(route) === 204, key).toBe(route.response === 'empty')
    }
    expect(routeSuccessStatus(apiRoutes['chats.create'])).toBe(201)
    expect(routeSuccessStatus(apiRoutes['chats.get'])).toBe(200)
    expect(isJsonResponse(apiRoutes['chats.get'])).toBe(true)
    expect(isJsonResponse(apiRoutes['chat.send'])).toBe(false)
  })

  it('only uses GET for routes without a body', () => {
    for (const key of API_ROUTE_KEYS) {
      const route: ApiRouteDef = apiRoutes[key]
      if (route.method === 'GET' || route.method === 'DELETE')
        expect(route.body ?? route.form, key).toBeUndefined()
    }
  })

  it('declares the audio and version routes as the contract says (ADR-029, ADR-030)', () => {
    const transcribe: ApiRouteDef = apiRoutes['audio.transcribe']
    const speech: ApiRouteDef = apiRoutes['audio.speech']
    const deleteMessage: ApiRouteDef = apiRoutes['chats.deleteMessage']
    // Multipart with a JSON response; JSON body with a binary response; params with the chat detail.
    expect(transcribe.form).toBeDefined()
    expect(transcribe.body).toBeUndefined()
    expect(isJsonResponse(transcribe)).toBe(true)
    expect(speech.body).toBeDefined()
    expect(speech.form).toBeUndefined()
    expect(speech.response).toBe('binary')
    expect(deleteMessage.response).toBe(apiRoutes['chats.get'].response)
    for (const route of [transcribe, speech, deleteMessage]) {
      expect(route.public).toBeUndefined()
      expect(route.fresh).toBeUndefined()
      expect(routeSuccessStatus(route)).toBe(200)
    }
  })

  it('declares the project, key and cleanup routes as the contract says (ADR-031, ADR-034, ADR-035)', () => {
    expect(API_MODULES).toHaveLength(23)
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'projects')).toEqual(['projects.list', 'projects.create', 'projects.update', 'projects.remove', 'projects.browse'])
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'keys')).toEqual(['keys.get', 'keys.rotate'])
    // Creating a project and rotating the key need fresh auth; nothing else of Phase 7 does.
    const fresh = (key: ApiRouteKey): boolean => (apiRoutes[key] as ApiRouteDef).fresh === true
    expect(fresh('projects.create')).toBe(true)
    expect(fresh('keys.rotate')).toBe(true)
    for (const key of ['projects.list', 'projects.update', 'projects.remove', 'projects.browse', 'keys.get', 'data.cleanupPreview', 'data.cleanup'] as const) {
      expect(fresh(key), key).toBe(false)
      expect((apiRoutes[key] as ApiRouteDef).public, key).toBeUndefined()
    }
    expect(routeSuccessStatus(apiRoutes['projects.create'])).toBe(201)
    expect(routeSuccessStatus(apiRoutes['projects.remove'])).toBe(204)
    expect(routeSuccessStatus(apiRoutes['keys.rotate'])).toBe(200)
    // The cleanup takes no body; the dry run is a GET.
    const cleanup: ApiRouteDef = apiRoutes['data.cleanup']
    expect(cleanup.body ?? cleanup.form).toBeUndefined()
    expect(apiRoutes['data.cleanupPreview'].method).toBe('GET')
  })
})

describe('matchApiRoute', () => {
  it('matches static and parametrized paths', () => {
    expect(matchApiRoute('get', '/health')?.key).toBe('health.get')
    expect(matchApiRoute('GET', '/icons/lobe/claude-color')).toMatchObject({ key: 'icons.get', params: { slug: 'claude-color' } })
    expect(matchApiRoute('POST', '/plugins/inspect')?.key).toBe('pluginInstall.inspect')
    expect(matchApiRoute('POST', '/plugins/drafts/test')?.key).toBe('pluginDrafts.test')
    expect(matchApiRoute('POST', '/plugins/dice-roller/trust')?.key).toBe('pluginInstall.trust')
    expect(matchApiRoute('POST', '/plugins')?.key).toBe('pluginDrafts.create')
    expect(matchApiRoute('DELETE', '/providers/openai/credentials')?.key).toBe('credentials.clear')
  })

  it('binds the rest path and decodes params', () => {
    expect(matchApiRoute('PUT', '/plugins/my-tool/files/src/index.ts')).toMatchObject({
      key: 'pluginFiles.write',
      params: { id: 'my-tool', path: 'src/index.ts' },
    })
    expect(matchApiRoute('GET', '/plugins/my-tool/files')?.key).toBe('pluginFiles.list')
    expect(matchApiRoute('PATCH', '/tools/mcp__srv__a%20b')?.params).toEqual({ name: 'mcp__srv__a b' })
  })

  it('matches the branch, data and share routes without shadowing', () => {
    const chat = '0199a8f0-0000-7000-8000-000000000001'
    const token = `sample0000000001${'A'.repeat(20)}_-`
    expect(matchApiRoute('POST', `/chats/${chat}/branch`)).toMatchObject({ key: 'chats.switchBranch', params: { id: chat } })
    expect(matchApiRoute('GET', '/data')?.key).toBe('data.summary')
    expect(matchApiRoute('GET', '/data/export')?.key).toBe('data.export')
    expect(matchApiRoute('POST', '/data/import')?.key).toBe('data.import')
    expect(matchApiRoute('POST', '/data/delete')?.key).toBe('data.deleteAll')
    expect(matchApiRoute('GET', '/shares')?.key).toBe('shares.list')
    expect(matchApiRoute('POST', '/shares')?.key).toBe('shares.create')
    expect(matchApiRoute('PATCH', '/shares/shr_sample0000000001')).toMatchObject({ key: 'shares.update', params: { id: 'shr_sample0000000001' } })
    expect(matchApiRoute('DELETE', '/shares/shr_sample0000000001')?.key).toBe('shares.remove')
    expect(matchApiRoute('GET', `/share/${token}`)).toMatchObject({ key: 'shares.view', params: { token } })
    expect(matchApiRoute('GET', `/share/${token}/files/file_sample0000000001`)).toMatchObject({
      key: 'shares.file',
      params: { token, fileId: 'file_sample0000000001' },
    })
    for (const [method, path] of [['GET', '/shares/shr_sample0000000001'], ['GET', '/share'], ['POST', '/share/x'], ['DELETE', '/data'], ['GET', '/data/import'], ['GET', `/share/${token}/files`]] as const)
      expect(matchApiRoute(method, path), `${method} ${path}`).toBeNull()
  })

  it('matches the version delete and audio routes (Phase 6) without shadowing', () => {
    const chat = '0199a8f0-0000-7000-8000-000000000001'
    expect(matchApiRoute('DELETE', `/chats/${chat}/messages/msg_sample0000000001`)).toMatchObject({
      key: 'chats.deleteMessage',
      params: { id: chat, messageId: 'msg_sample0000000001' },
    })
    expect(matchApiRoute('DELETE', `/chats/${chat}`)?.key).toBe('chats.remove')
    expect(matchApiRoute('POST', '/audio/transcriptions')?.key).toBe('audio.transcribe')
    expect(matchApiRoute('POST', '/audio/speech')?.key).toBe('audio.speech')
    for (const [method, path] of [['GET', `/chats/${chat}/messages/msg_sample0000000001`], ['DELETE', `/chats/${chat}/messages`], ['GET', '/audio/speech'], ['POST', '/audio'], ['PUT', '/audio/transcriptions']] as const)
      expect(matchApiRoute(method, path), `${method} ${path}`).toBeNull()
  })

  it('matches the project, key and cleanup routes (Phase 7) without shadowing', () => {
    const project = 'prj_ABCdef0123456789'
    expect(matchApiRoute('GET', '/projects')?.key).toBe('projects.list')
    expect(matchApiRoute('POST', '/projects')?.key).toBe('projects.create')
    expect(matchApiRoute('GET', '/projects/browse')?.key).toBe('projects.browse')
    expect(matchApiRoute('PATCH', `/projects/${project}`)).toMatchObject({ key: 'projects.update', params: { id: project } })
    expect(matchApiRoute('DELETE', `/projects/${project}`)).toMatchObject({ key: 'projects.remove', params: { id: project } })
    expect(matchApiRoute('GET', '/keys')?.key).toBe('keys.get')
    expect(matchApiRoute('POST', '/keys/rotate')?.key).toBe('keys.rotate')
    expect(matchApiRoute('GET', '/data/cleanup')?.key).toBe('data.cleanupPreview')
    expect(matchApiRoute('POST', '/data/cleanup')?.key).toBe('data.cleanup')
    for (const [method, path] of [['GET', `/projects/${project}`], ['POST', '/projects/browse'], ['GET', '/keys/rotate'], ['POST', '/keys'], ['DELETE', '/data/cleanup'], ['GET', `/projects/${project}/browse`]] as const)
      expect(matchApiRoute(method, path), `${method} ${path}`).toBeNull()
  })

  it('returns null for unknown routes, methods and bad encodings', () => {
    expect(matchApiRoute('GET', '/nope')).toBeNull()
    expect(matchApiRoute('PATCH', '/health')).toBeNull()
    expect(matchApiRoute('GET', '/chats/%E0%A4%A')).toBeNull()
    expect(matchApiRoute('GET', '/chats/')).toBeNull()
    expect(matchApiRoute('GET', '/plugins/x/files/a//b')).toBeNull()
  })

  it('matches every route of the table', () => {
    for (const key of API_ROUTE_KEYS) {
      const route: ApiRouteDef = apiRoutes[key]
      const path = route.path.replace(/:\w+/g, 'x1').replace('*', 'dir/file.txt')
      expect(matchApiRoute(route.method, path)?.key, key).toBe(key)
    }
  })
})
