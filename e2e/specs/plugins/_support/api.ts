// HTTP helpers of the plugin specs (setup, cleanup and server-side assertions) over Playwright's `request` fixture,
// whose `baseURL` is the server under test. Shapes follow docs/API.md; only the fields the specs read are typed.
// State-changing calls send no `Origin` header, which the server's CSRF check accepts (curl-like clients).
import type { APIRequestContext, APIResponse } from '@playwright/test'
import type { Buffer } from 'node:buffer'
import type { FixtureManifest } from '../../../fixtures/plugins.ts'

export interface PluginContributions {
  providers: string[]
  models: number
  tools: string[]
  mcpServers: string[]
  commands: string[]
  hooks: string[]
}

export interface PluginSummary {
  id: string
  name: string
  description: string | null
  kind: 'declarative' | 'code'
  source: string
  builtin: boolean
  removable: boolean
  enabled: boolean
  state: string
  runsCode: boolean
  contributions: PluginContributions
}

export interface PluginDetail extends PluginSummary {
  editable: boolean
  trust: { required: boolean, trusted: boolean, hash: string | null, trustedHash: string | null }
}

export interface ToolSummary {
  name: string
  pluginId: string
  mcpServerId: string | null
  policy: string | null
  enabled: boolean
  available: boolean
}

export interface ProviderSummary {
  id: string
  name: string
  pluginId: string
  enabled: boolean
  status: 'connected' | 'not_configured' | 'env' | 'error'
}

export interface McpServerSummary {
  id: string
  name: string
  pluginId: string
  status: 'disabled' | 'connecting' | 'connected' | 'error'
  tools: string[]
}

export interface ErrorEnvelope {
  error: { code: string, message: string, details?: unknown }
}

/** The JSON body of a successful response; otherwise throws with the status and the error envelope. */
async function expectOk<T>(response: APIResponse, what: string): Promise<T> {
  if (!response.ok())
    throw new Error(`${what} failed with HTTP ${response.status()}: ${await response.text()}`)
  if (response.status() === 204)
    return undefined as T
  return await response.json() as T
}

function path(id: string): string {
  return encodeURIComponent(id)
}

// ---------- plugins ----------

export async function listPlugins(request: APIRequestContext): Promise<PluginSummary[]> {
  return (await expectOk<{ items: PluginSummary[] }>(await request.get('/api/plugins'), 'GET /api/plugins')).items
}

/** The plugin detail, or null when the plugin is not installed. */
export async function getPlugin(request: APIRequestContext, id: string): Promise<PluginDetail | null> {
  const response = await request.get(`/api/plugins/${path(id)}`)
  if (response.status() === 404)
    return null
  return expectOk<PluginDetail>(response, `GET /api/plugins/${id}`)
}

/** Uninstalls a plugin; nothing happens when it is not installed. */
export async function removePlugin(request: APIRequestContext, id: string, options: { keepData?: boolean } = {}): Promise<void> {
  const response = await request.delete(`/api/plugins/${path(id)}?keepData=${options.keepData === true}`)
  if (response.status() === 404)
    return
  await expectOk(response, `DELETE /api/plugins/${id}`)
}

export async function setPluginEnabled(request: APIRequestContext, id: string, enabled: boolean): Promise<PluginDetail> {
  const action = enabled ? 'enable' : 'disable'
  return expectOk<PluginDetail>(await request.post(`/api/plugins/${path(id)}/${action}`), `POST /api/plugins/${id}/${action}`)
}

/** Creates a declarative plugin (`POST /api/plugins`, as the provider wizard does). */
export async function createDeclarativePlugin(
  request: APIRequestContext,
  manifest: FixtureManifest,
  credentials?: Record<string, Record<string, string>>,
): Promise<PluginDetail> {
  const data = credentials === undefined ? { manifest } : { manifest, credentials }
  return expectOk<PluginDetail>(await request.post('/api/plugins', { data }), `POST /api/plugins (${manifest.id})`)
}

/** Removes a plugin left over by an earlier run, then creates it again. */
export async function recreateDeclarativePlugin(request: APIRequestContext, manifest: FixtureManifest): Promise<PluginDetail> {
  await removePlugin(request, manifest.id)
  return createDeclarativePlugin(request, manifest)
}

interface FilePart {
  name: string
  mimeType: string
  buffer: Buffer
}

function zipPart(fileName: string, zip: Buffer): FilePart {
  return { name: fileName, mimeType: 'application/zip', buffer: zip }
}

/** `POST /api/plugins/inspect` with a zip; the raw response (specs assert failures too). */
export async function inspectZip(request: APIRequestContext, fileName: string, zip: Buffer): Promise<APIResponse> {
  return request.post('/api/plugins/inspect', { multipart: { file: zipPart(fileName, zip) } })
}

/** `POST /api/plugins/install` with a zip; the raw response. */
export async function postZipInstall(request: APIRequestContext, fileName: string, zip: Buffer, options: { trust?: boolean } = {}): Promise<APIResponse> {
  const multipart: Record<string, string | FilePart> = { file: zipPart(fileName, zip) }
  if (options.trust)
    multipart.trust = 'true'
  return request.post('/api/plugins/install', { multipart })
}

export async function installZip(request: APIRequestContext, fileName: string, zip: Buffer, options: { trust?: boolean } = {}): Promise<PluginDetail> {
  return expectOk<PluginDetail>(await postZipInstall(request, fileName, zip, options), `POST /api/plugins/install (${fileName})`)
}

export async function readPluginFile(request: APIRequestContext, id: string, file: string): Promise<string> {
  const encoded = file.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const body = await expectOk<{ content: string }>(await request.get(`/api/plugins/${path(id)}/files/${encoded}`), `GET /api/plugins/${id}/files/${file}`)
  return body.content
}

// ---------- providers, tools, MCP ----------

export async function listProviders(request: APIRequestContext): Promise<ProviderSummary[]> {
  return (await expectOk<{ items: ProviderSummary[] }>(await request.get('/api/providers'), 'GET /api/providers')).items
}

export async function getProvider(request: APIRequestContext, id: string): Promise<ProviderSummary | null> {
  return (await listProviders(request)).find(provider => provider.id === id) ?? null
}

export async function setProviderEnabled(request: APIRequestContext, id: string, enabled: boolean): Promise<ProviderSummary> {
  return expectOk<ProviderSummary>(await request.patch(`/api/providers/${path(id)}`, { data: { enabled } }), `PATCH /api/providers/${id}`)
}

export async function setProviderCredentials(request: APIRequestContext, id: string, values: Record<string, string>): Promise<ProviderSummary> {
  return expectOk<ProviderSummary>(
    await request.put(`/api/providers/${path(id)}/credentials`, { data: { values } }),
    `PUT /api/providers/${id}/credentials`,
  )
}

export async function listTools(request: APIRequestContext): Promise<ToolSummary[]> {
  return (await expectOk<{ items: ToolSummary[] }>(await request.get('/api/tools'), 'GET /api/tools')).items
}

export async function toolNames(request: APIRequestContext): Promise<string[]> {
  return (await listTools(request)).map(tool => tool.name)
}

export async function listMcpServers(request: APIRequestContext): Promise<McpServerSummary[]> {
  return (await expectOk<{ items: McpServerSummary[] }>(await request.get('/api/mcp'), 'GET /api/mcp')).items
}

// ---------- chats ----------

/** Stops a run the chat may still have, then deletes the chat; nothing happens when it does not exist. */
export async function removeChat(request: APIRequestContext, id: string): Promise<void> {
  await request.post(`/api/chat/${path(id)}/stop`)
  const response = await request.delete(`/api/chats/${path(id)}`)
  if (response.status() === 404)
    return
  await expectOk(response, `DELETE /api/chats/${id}`)
}

/** Deletes a user-configured MCP server; nothing happens when it does not exist. */
export async function removeMcpServer(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.delete(`/api/mcp/${path(id)}`)
  if (response.status() === 404)
    return
  await expectOk(response, `DELETE /api/mcp/${id}`)
}
