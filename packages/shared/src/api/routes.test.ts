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
  it('has 132 routes keyed <module>.<action>', () => {
    expect(API_ROUTE_KEYS).toHaveLength(132)
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
    expect(index).toHaveLength(132)
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

  it('declares the change and shell rule routes as the contract says (ADR-036, ADR-037, ADR-038)', () => {
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'changes')).toEqual([
      'changes.list',
      'changes.diff',
      'changes.git',
      'changes.revert',
      'changes.undo',
      'changes.rewindPreview',
      'changes.rewind',
    ])
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'shellRules')).toEqual(['shellRules.list', 'shellRules.create', 'shellRules.remove'])
    const phase8 = API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'changes' || apiRoutes[key].module === 'shellRules')
    // None needs fresh auth (a session can already approve its own shell calls) and none is public.
    for (const key of phase8) {
      const route: ApiRouteDef = apiRoutes[key]
      expect(route.fresh, key).toBeUndefined()
      expect(route.public, key).toBeUndefined()
    }
    // Every change route is chat-scoped; the queries and bodies are the ones of the contract.
    for (const key of phase8.filter(key => apiRoutes[key].module === 'changes'))
      expect(apiRoutes[key].path.startsWith('/chats/:id/'), key).toBe(true)
    expect((apiRoutes['changes.diff'] as ApiRouteDef).query).toBeDefined()
    expect((apiRoutes['changes.rewindPreview'] as ApiRouteDef).query).toBeDefined()
    for (const key of ['changes.revert', 'changes.undo', 'changes.rewind'] as const) {
      expect((apiRoutes[key] as ApiRouteDef).body, key).toBeDefined()
      expect(apiRoutes[key].response, key).toBe(apiRoutes['changes.rewind'].response)
    }
    expect(routeSuccessStatus(apiRoutes['shellRules.create'])).toBe(201)
    expect(routeSuccessStatus(apiRoutes['shellRules.remove'])).toBe(204)
    expect(routeSuccessStatus(apiRoutes['changes.rewind'])).toBe(200)
  })

  it('declares the queue and project file routes as the contract says (ADR-042)', () => {
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'chatQueue')).toEqual(['chatQueue.list', 'chatQueue.add', 'chatQueue.remove'])
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'projectFiles')).toEqual(['projectFiles.search', 'projectFiles.attach'])
    const phase9 = API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'chatQueue' || apiRoutes[key].module === 'projectFiles')
    // None needs fresh auth and none is public.
    for (const key of phase9) {
      const route: ApiRouteDef = apiRoutes[key]
      expect(route.fresh, key).toBeUndefined()
      expect(route.public, key).toBeUndefined()
    }
    for (const key of phase9.filter(key => apiRoutes[key].module === 'chatQueue'))
      expect(apiRoutes[key].path.startsWith('/chat/:id/queue'), key).toBe(true)
    for (const key of phase9.filter(key => apiRoutes[key].module === 'projectFiles'))
      expect(apiRoutes[key].path.startsWith('/projects/:id/files'), key).toBe(true)
    expect(routeSuccessStatus(apiRoutes['chatQueue.add'])).toBe(201)
    expect(routeSuccessStatus(apiRoutes['chatQueue.remove'])).toBe(204)
    expect(routeSuccessStatus(apiRoutes['projectFiles.attach'])).toBe(201)
    // The attach answer is the upload answer.
    expect(apiRoutes['projectFiles.attach'].response).toBe(apiRoutes['files.upload'].response)
    expect((apiRoutes['projectFiles.search'] as ApiRouteDef).query).toBeDefined()
  })

  it('declares the customization, memory and background task routes as the contract says (ADR-044 … ADR-047)', () => {
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'customizations')).toEqual([
      'customizations.list',
      'customizations.source',
      'customizations.create',
      'customizations.get',
      'customizations.update',
      'customizations.remove',
    ])
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'memory')).toEqual(['memory.remember'])
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'chatTasks')).toEqual(['chatTasks.list', 'chatTasks.stop'])
    const phase10 = API_ROUTE_KEYS.filter(key => ['customizations', 'memory', 'chatTasks'].includes(apiRoutes[key].module))
    expect(phase10).toHaveLength(9)
    // None needs fresh auth (definitions only restrict; Remember writes through the journal) and none is public.
    for (const key of phase10) {
      const route: ApiRouteDef = apiRoutes[key]
      expect(route.fresh, key).toBeUndefined()
      expect(route.public, key).toBeUndefined()
    }
    for (const key of phase10.filter(key => apiRoutes[key].module === 'chatTasks'))
      expect(apiRoutes[key].path.startsWith('/chat/:id/tasks'), key).toBe(true)
    expect(routeSuccessStatus(apiRoutes['customizations.create'])).toBe(201)
    expect(routeSuccessStatus(apiRoutes['customizations.remove'])).toBe(204)
    expect(routeSuccessStatus(apiRoutes['memory.remember'])).toBe(200)
    expect(routeSuccessStatus(apiRoutes['chatTasks.stop'])).toBe(200)
    // The personal definition answers are one shape; the stop answers the task.
    expect(apiRoutes['customizations.get'].response).toBe(apiRoutes['customizations.create'].response)
    expect(apiRoutes['customizations.update'].response).toBe(apiRoutes['customizations.create'].response)
    expect((apiRoutes['customizations.list'] as ApiRouteDef).query).toBeDefined()
    expect((apiRoutes['customizations.source'] as ApiRouteDef).query).toBeDefined()
    // `GET /commands` gains the project query (Phase 10).
    expect((apiRoutes['commands.list'] as ApiRouteDef).query).toBeDefined()
  })

  it('declares the hook, project trust and project MCP routes as the contract says (ADR-048 … ADR-050)', () => {
    expect(API_MODULES.slice(-7, -3)).toEqual(['hooks', 'projectTrust', 'projectMcp', 'shares'])
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'hooks')).toEqual(['hooks.list', 'hooks.runs', 'hooks.create', 'hooks.update', 'hooks.remove'])
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'projectTrust')).toEqual(['projectTrust.list', 'projectTrust.approve', 'projectTrust.revoke'])
    expect(API_ROUTE_KEYS.filter(key => apiRoutes[key].module === 'projectMcp')).toEqual(['projectMcp.list', 'projectMcp.setVariables', 'projectMcp.reconnect'])
    const phase11 = API_ROUTE_KEYS.filter(key => ['hooks', 'projectTrust', 'projectMcp'].includes(apiRoutes[key].module))
    expect(phase11).toHaveLength(11)
    // Creating a hook, approving project items and setting project MCP variables always need fresh auth; changing a
    // hook needs it unless the body only turns the hook off (enforced by the route, so the table has no flag).
    const fresh = phase11.filter(key => (apiRoutes[key] as ApiRouteDef).fresh === true)
    expect(fresh).toEqual(['hooks.create', 'projectTrust.approve', 'projectMcp.setVariables'])
    for (const key of phase11)
      expect((apiRoutes[key] as ApiRouteDef).public, key).toBeUndefined()
    for (const key of phase11.filter(key => apiRoutes[key].module !== 'hooks'))
      expect(apiRoutes[key].path.startsWith('/projects/:id/'), key).toBe(true)
    expect(routeSuccessStatus(apiRoutes['hooks.create'])).toBe(201)
    expect(routeSuccessStatus(apiRoutes['hooks.remove'])).toBe(204)
    expect(routeSuccessStatus(apiRoutes['projectTrust.approve'])).toBe(200)
    expect(routeSuccessStatus(apiRoutes['projectTrust.revoke'])).toBe(200)
    // Approve and revoke answer the fresh list; setting variables answers the servers and variables.
    expect(apiRoutes['projectTrust.approve'].response).toBe(apiRoutes['projectTrust.list'].response)
    expect(apiRoutes['projectTrust.revoke'].response).toBe(apiRoutes['projectTrust.list'].response)
    expect(apiRoutes['projectMcp.setVariables'].response).toBe(apiRoutes['projectMcp.list'].response)
    expect(apiRoutes['hooks.update'].response).toBe(apiRoutes['hooks.create'].response)
    expect((apiRoutes['hooks.list'] as ApiRouteDef).query).toBeDefined()
  })

  it('declares the marketplace, Claude Code import and project definition routes as the contract says (ADR-054 … ADR-056)', () => {
    expect(API_MODULES).toHaveLength(36)
    expect(API_MODULES.slice(-3)).toEqual(['marketplaces', 'claudeImport', 'projectDefinitions'])
    const keysOf = (module: string): ApiRouteKey[] => API_ROUTE_KEYS.filter(key => apiRoutes[key].module === module)
    expect(keysOf('marketplaces')).toEqual(['marketplaces.list', 'marketplaces.add', 'marketplaces.get', 'marketplaces.refresh', 'marketplaces.remove'])
    expect(keysOf('claudeImport')).toEqual(['claudeImport.home', 'claudeImport.scan', 'claudeImport.upload', 'claudeImport.apply'])
    expect(keysOf('projectDefinitions')).toEqual(['projectDefinitions.read', 'projectDefinitions.write', 'projectDefinitions.remove'])
    const phase12 = [...keysOf('marketplaces'), ...keysOf('claudeImport'), ...keysOf('projectDefinitions')]
    expect(phase12).toHaveLength(12)
    // Scanning the server's home folder and applying an import need fresh auth; nothing else of Phase 12 does (editing
    // project files approves nothing; installs from a marketplace go through `pluginInstall.install`).
    expect(phase12.filter(key => (apiRoutes[key] as ApiRouteDef).fresh === true)).toEqual(['claudeImport.scan', 'claudeImport.apply'])
    expect(API_ROUTE_KEYS.filter(key => (apiRoutes[key] as ApiRouteDef).fresh === true)).toHaveLength(14)
    for (const key of phase12)
      expect((apiRoutes[key] as ApiRouteDef).public, key).toBeUndefined()
    for (const key of keysOf('projectDefinitions'))
      expect(apiRoutes[key].path, key).toBe('/projects/:id/definitions/file')
    expect(routeSuccessStatus(apiRoutes['marketplaces.add'])).toBe(201)
    expect(routeSuccessStatus(apiRoutes['marketplaces.remove'])).toBe(204)
    expect(routeSuccessStatus(apiRoutes['projectDefinitions.remove'])).toBe(204)
    expect(routeSuccessStatus(apiRoutes['claudeImport.upload'])).toBe(200)
    // The upload is multipart only; the add, refresh and get answers are one shape; scan and upload answer the plan.
    const upload = apiRoutes['claudeImport.upload'] as ApiRouteDef
    expect(upload.form).toBeDefined()
    expect(upload.body).toBeUndefined()
    expect(apiRoutes['marketplaces.refresh'].response).toBe(apiRoutes['marketplaces.add'].response)
    expect(apiRoutes['marketplaces.get'].response).toBe(apiRoutes['marketplaces.add'].response)
    expect(apiRoutes['claudeImport.scan'].response).toBe(apiRoutes['claudeImport.upload'].response)
    expect((apiRoutes['claudeImport.scan'] as ApiRouteDef).body).toBeUndefined()
    // `pluginInstall.inspect` keeps its key and takes the format field in its multipart form.
    expect((apiRoutes['pluginInstall.inspect'] as ApiRouteDef).form).toBeDefined()
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

  it('matches the change and shell rule routes (Phase 8) without shadowing the chat routes', () => {
    const chat = '0199a8f0-0000-7000-8000-000000000001'
    const rule = 'srl_ABCdef0123456789'
    expect(matchApiRoute('GET', `/chats/${chat}/changes`)).toMatchObject({ key: 'changes.list', params: { id: chat } })
    expect(matchApiRoute('GET', `/chats/${chat}/changes/diff`)).toMatchObject({ key: 'changes.diff', params: { id: chat } })
    expect(matchApiRoute('GET', `/chats/${chat}/git`)).toMatchObject({ key: 'changes.git', params: { id: chat } })
    expect(matchApiRoute('POST', `/chats/${chat}/changes/revert`)?.key).toBe('changes.revert')
    expect(matchApiRoute('POST', `/chats/${chat}/changes/undo`)?.key).toBe('changes.undo')
    expect(matchApiRoute('GET', `/chats/${chat}/rewind`)?.key).toBe('changes.rewindPreview')
    expect(matchApiRoute('POST', `/chats/${chat}/rewind`)?.key).toBe('changes.rewind')
    expect(matchApiRoute('GET', '/shell-rules')?.key).toBe('shellRules.list')
    expect(matchApiRoute('POST', '/shell-rules')?.key).toBe('shellRules.create')
    expect(matchApiRoute('DELETE', `/shell-rules/${rule}`)).toMatchObject({ key: 'shellRules.remove', params: { id: rule } })
    // The chat routes keep their keys.
    expect(matchApiRoute('GET', `/chats/${chat}`)?.key).toBe('chats.get')
    expect(matchApiRoute('GET', `/chats/${chat}/export`)?.key).toBe('chats.export')
    expect(matchApiRoute('POST', `/chats/${chat}/branch`)?.key).toBe('chats.switchBranch')
    expect(matchApiRoute('DELETE', `/chats/${chat}/messages/msg_sample0000000001`)?.key).toBe('chats.deleteMessage')
    for (const [method, path] of [
      ['POST', `/chats/${chat}/changes`],
      ['DELETE', `/chats/${chat}/changes`],
      ['GET', `/chats/${chat}/changes/revert`],
      ['POST', `/chats/${chat}/changes/diff`],
      ['POST', `/chats/${chat}/git`],
      ['DELETE', `/chats/${chat}/rewind`],
      ['GET', `/chats/${chat}/changes/undo`],
      ['GET', `/shell-rules/${rule}`],
      ['PATCH', `/shell-rules/${rule}`],
      ['DELETE', '/shell-rules'],
    ] as const)
      expect(matchApiRoute(method, path), `${method} ${path}`).toBeNull()
  })

  it('matches the queue and project file routes (Phase 9) without shadowing', () => {
    const chat = '0199a8f0-0000-7000-8000-000000000001'
    const project = 'prj_ABCdef0123456789'
    expect(matchApiRoute('GET', `/chat/${chat}/queue`)).toMatchObject({ key: 'chatQueue.list', params: { id: chat } })
    expect(matchApiRoute('POST', `/chat/${chat}/queue`)).toMatchObject({ key: 'chatQueue.add', params: { id: chat } })
    expect(matchApiRoute('DELETE', `/chat/${chat}/queue/msg_sample0000000001`)).toMatchObject({
      key: 'chatQueue.remove',
      params: { id: chat, itemId: 'msg_sample0000000001' },
    })
    expect(matchApiRoute('GET', `/projects/${project}/files`)).toMatchObject({ key: 'projectFiles.search', params: { id: project } })
    expect(matchApiRoute('POST', `/projects/${project}/files/attach`)).toMatchObject({ key: 'projectFiles.attach', params: { id: project } })
    // The neighbors keep their keys.
    expect(matchApiRoute('GET', `/chat/${chat}/stream`)?.key).toBe('chat.resume')
    expect(matchApiRoute('POST', `/chat/${chat}/stop`)?.key).toBe('chat.stop')
    expect(matchApiRoute('GET', '/projects/browse')?.key).toBe('projects.browse')
    expect(matchApiRoute('GET', '/plugins/my-tool/files')?.key).toBe('pluginFiles.list')
    for (const [method, path] of [
      ['DELETE', `/chat/${chat}/queue`],
      ['GET', `/chat/${chat}/queue/msg_sample0000000001`],
      ['PATCH', `/chat/${chat}/queue/msg_sample0000000001`],
      ['POST', `/projects/${project}/files`],
      ['GET', `/projects/${project}/files/attach`],
      ['GET', `/projects/${project}/files/src/app.ts`],
    ] as const)
      expect(matchApiRoute(method, path), `${method} ${path}`).toBeNull()
  })

  it('matches the customization, memory and background task routes (Phase 10) without shadowing', () => {
    const chat = '0199a8f0-0000-7000-8000-000000000001'
    const customization = 'cus_ABCdef0123456789'
    const task = 'bgt_ABCdef0123456789'
    expect(matchApiRoute('GET', '/customizations')?.key).toBe('customizations.list')
    expect(matchApiRoute('POST', '/customizations')?.key).toBe('customizations.create')
    // The static `source` segment wins over the `:id` param.
    expect(matchApiRoute('GET', '/customizations/source')?.key).toBe('customizations.source')
    expect(matchApiRoute('GET', `/customizations/${customization}`)).toMatchObject({ key: 'customizations.get', params: { id: customization } })
    expect(matchApiRoute('PATCH', `/customizations/${customization}`)?.key).toBe('customizations.update')
    expect(matchApiRoute('DELETE', `/customizations/${customization}`)?.key).toBe('customizations.remove')
    expect(matchApiRoute('POST', '/memory')?.key).toBe('memory.remember')
    expect(matchApiRoute('GET', `/chat/${chat}/tasks`)).toMatchObject({ key: 'chatTasks.list', params: { id: chat } })
    expect(matchApiRoute('POST', `/chat/${chat}/tasks/${task}/stop`)).toMatchObject({ key: 'chatTasks.stop', params: { id: chat, taskId: task } })
    // The neighbors keep their keys.
    expect(matchApiRoute('POST', `/chat/${chat}/stop`)?.key).toBe('chat.stop')
    expect(matchApiRoute('GET', `/chat/${chat}/queue`)?.key).toBe('chatQueue.list')
    expect(matchApiRoute('GET', '/commands')?.key).toBe('commands.list')
    for (const [method, path] of [
      ['DELETE', '/customizations'],
      ['PUT', `/customizations/${customization}`],
      ['GET', '/memory'],
      ['DELETE', '/memory'],
      ['POST', `/chat/${chat}/tasks`],
      ['GET', `/chat/${chat}/tasks/${task}`],
      ['POST', `/chat/${chat}/tasks/stop`],
      ['DELETE', `/chat/${chat}/tasks/${task}`],
    ] as const)
      expect(matchApiRoute(method, path), `${method} ${path}`).toBeNull()
  })

  it('matches the hook, project trust and project MCP routes (Phase 11) without shadowing', () => {
    const project = 'prj_ABCdef0123456789'
    const hook = 'hok_ABCdef0123456789'
    const sha = 'a'.repeat(64)
    expect(matchApiRoute('GET', '/hooks')?.key).toBe('hooks.list')
    expect(matchApiRoute('GET', '/hooks/runs')?.key).toBe('hooks.runs')
    expect(matchApiRoute('POST', '/hooks')?.key).toBe('hooks.create')
    expect(matchApiRoute('PATCH', `/hooks/${hook}`)).toMatchObject({ key: 'hooks.update', params: { id: hook } })
    expect(matchApiRoute('DELETE', `/hooks/${hook}`)).toMatchObject({ key: 'hooks.remove', params: { id: hook } })
    expect(matchApiRoute('GET', `/projects/${project}/trust`)).toMatchObject({ key: 'projectTrust.list', params: { id: project } })
    expect(matchApiRoute('POST', `/projects/${project}/trust`)?.key).toBe('projectTrust.approve')
    expect(matchApiRoute('DELETE', `/projects/${project}/trust/${sha}`)).toMatchObject({ key: 'projectTrust.revoke', params: { id: project, sha256: sha } })
    expect(matchApiRoute('GET', `/projects/${project}/mcp`)).toMatchObject({ key: 'projectMcp.list', params: { id: project } })
    expect(matchApiRoute('PUT', `/projects/${project}/mcp/variables`)).toMatchObject({ key: 'projectMcp.setVariables', params: { id: project } })
    expect(matchApiRoute('POST', `/projects/${project}/mcp/memory/reconnect`)).toMatchObject({ key: 'projectMcp.reconnect', params: { id: project, serverId: 'memory' } })
    // The neighbors keep their keys.
    expect(matchApiRoute('GET', `/projects/${project}/files`)?.key).toBe('projectFiles.search')
    expect(matchApiRoute('DELETE', `/projects/${project}`)?.key).toBe('projects.remove')
    expect(matchApiRoute('GET', '/projects/browse')?.key).toBe('projects.browse')
    for (const [method, path] of [
      ['GET', `/hooks/${hook}`],
      ['PATCH', '/hooks/runs/x'],
      ['DELETE', '/hooks'],
      ['PUT', `/projects/${project}/trust`],
      ['GET', `/projects/${project}/trust/${sha}`],
      ['DELETE', `/projects/${project}/trust`],
      ['GET', `/projects/${project}/mcp/variables`],
      ['POST', `/projects/${project}/mcp`],
      ['GET', `/projects/${project}/mcp/memory/reconnect`],
      ['PUT', `/projects/${project}/mcp/memory/variables`],
    ] as const)
      expect(matchApiRoute(method, path), `${method} ${path}`).toBeNull()
  })

  it('matches the Phase 12 routes without shadowing their neighbors (ADR-054 … ADR-056)', () => {
    const marketplace = 'mkt_ABCdef0123456789'
    const project = 'prj_ABCdef0123456789'
    expect(matchApiRoute('GET', '/marketplaces')?.key).toBe('marketplaces.list')
    expect(matchApiRoute('POST', '/marketplaces')?.key).toBe('marketplaces.add')
    expect(matchApiRoute('GET', `/marketplaces/${marketplace}`)).toMatchObject({ key: 'marketplaces.get', params: { id: marketplace } })
    expect(matchApiRoute('POST', `/marketplaces/${marketplace}/refresh`)).toMatchObject({ key: 'marketplaces.refresh', params: { id: marketplace } })
    expect(matchApiRoute('DELETE', `/marketplaces/${marketplace}`)?.key).toBe('marketplaces.remove')
    expect(matchApiRoute('GET', '/claude-import/home')?.key).toBe('claudeImport.home')
    expect(matchApiRoute('POST', '/claude-import/scan')?.key).toBe('claudeImport.scan')
    expect(matchApiRoute('POST', '/claude-import/upload')?.key).toBe('claudeImport.upload')
    expect(matchApiRoute('POST', '/claude-import/apply')?.key).toBe('claudeImport.apply')
    for (const method of ['GET', 'PUT', 'DELETE'])
      expect(matchApiRoute(method, `/projects/${project}/definitions/file`)?.params).toEqual({ id: project })
    expect(matchApiRoute('GET', `/projects/${project}/definitions/file`)?.key).toBe('projectDefinitions.read')
    expect(matchApiRoute('PUT', `/projects/${project}/definitions/file`)?.key).toBe('projectDefinitions.write')
    expect(matchApiRoute('DELETE', `/projects/${project}/definitions/file`)?.key).toBe('projectDefinitions.remove')
    // The plugin routes keep `/plugins/marketplaces` (the web page) out of the API.
    expect(matchApiRoute('GET', '/plugins/marketplaces')?.key).toBe('plugins.get')
    for (const [method, path] of [
      ['PUT', '/marketplaces'],
      ['GET', `/marketplaces/${marketplace}/refresh`],
      ['GET', '/claude-import/scan'],
      ['POST', '/claude-import/home'],
      ['POST', `/projects/${project}/definitions/file`],
      ['GET', `/projects/${project}/definitions`],
    ] as const)
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
