// The route table: one entry per endpoint of API.md, keyed `<module>.<action>` (API.md sections 3.3 and 8).
import type { z } from 'zod'
import { chatRequestBodySchema, chatStopResultSchema } from '../chat.ts'
import { audioSpeechBodySchema, audioTranscribeFormSchema, audioTranscriptionSchema } from '../schemas/audio.ts'
import { backgroundTaskListSchema, backgroundTaskSchema, chatTaskParamsSchema } from '../schemas/background-tasks.ts'
import {
  changeDiffQuerySchema,
  changeRevertBodySchema,
  changeUndoBodySchema,
  chatChangesSchema,
  fileDiffSchema,
  gitStatusSchema,
  restoreResultSchema,
  rewindBodySchema,
  rewindPreviewSchema,
  rewindQuerySchema,
} from '../schemas/changes.ts'
import {
  chatBranchBodySchema,
  chatCreateSchema,
  chatDetailSchema,
  chatExportQuerySchema,
  chatsQuerySchema,
  chatSummarySchema,
  chatUpdateSchema,
} from '../schemas/chats.ts'
import {
  claudeImportApplyBodySchema,
  claudeImportApplyResultSchema,
  claudeImportHomeSchema,
  claudeImportPlanSchema,
  claudeImportUploadFormSchema,
} from '../schemas/claude-import.ts'
import { cursorPageSchema, listResponseSchema } from '../schemas/common.ts'
import {
  customizationCreateSchema,
  customizationListSchema,
  customizationParamsSchema,
  customizationSchema,
  customizationSourceQuerySchema,
  customizationSourceResultSchema,
  customizationsQuerySchema,
  customizationUpdateSchema,
  rememberBodySchema,
  rememberResultSchema,
} from '../schemas/customizations.ts'
import {
  dataCleanupPreviewSchema,
  dataCleanupResultSchema,
  dataDeleteBodySchema,
  dataDeleteResultSchema,
  dataExportQuerySchema,
  dataImportFormSchema,
  dataImportResultSchema,
  dataSummarySchema,
} from '../schemas/data.ts'
import { fileRefSchema } from '../schemas/files.ts'
import {
  hookCreateSchema,
  hookListSchema,
  hookParamsSchema,
  hookRunListSchema,
  hooksQuerySchema,
  hookUpdateSchema,
  personalHookSchema,
} from '../schemas/hooks.ts'
import { lobeIconListSchema } from '../schemas/icons.ts'
import { keyRotateBodySchema, keyRotationResultSchema, keyStatusSchema } from '../schemas/keys.ts'
import {
  marketplaceAddBodySchema,
  marketplaceDetailSchema,
  marketplaceListSchema,
  marketplaceParamsSchema,
} from '../schemas/marketplaces.ts'
import {
  catalogModelSchema,
  customModelInputSchema,
  customModelKeySchema,
  modelPrefsUpdateSchema,
  modelsQuerySchema,
} from '../schemas/models.ts'
import {
  chatMessageParamsSchema,
  chatParamsSchema,
  chatQueueItemParamsSchema,
  fileParamsSchema,
  fileUploadFormSchema,
  iconParamsSchema,
  mcpServerParamsSchema,
  pluginFileParamsSchema,
  pluginParamsSchema,
  projectParamsSchema,
  providerParamsSchema,
  shareFileParamsSchema,
  shareParamsSchema,
  sharePublicParamsSchema,
  shellRuleParamsSchema,
  toolParamsSchema,
} from '../schemas/params.ts'
import {
  buildResultSchema,
  draftTestRequestSchema,
  draftTestResultSchema,
  pluginBuildBodySchema,
  pluginDetailSchema,
  pluginDraftSchema,
  pluginFileContentSchema,
  pluginFileEntrySchema,
  pluginFileWriteSchema,
  pluginInspectBodySchema,
  pluginInspectFormSchema,
  pluginInspectionSchema,
  pluginInstallBodySchema,
  pluginInstallFormSchema,
  pluginLogEntrySchema,
  pluginLogsQuerySchema,
  pluginManifestUpdateSchema,
  pluginRemoveQuerySchema,
  pluginSettingsUpdateSchema,
  pluginSettingsViewSchema,
  pluginSummarySchema,
  pluginTrustBodySchema,
  scaffoldRequestSchema,
} from '../schemas/plugins.ts'
import {
  projectDefinitionFileSchema,
  projectDefinitionQuerySchema,
  projectDefinitionRemoveQuerySchema,
  projectDefinitionWriteBodySchema,
  projectDefinitionWriteResultSchema,
} from '../schemas/project-definitions.ts'
import { projectFileAttachBodySchema, projectFileSearchSchema, projectFilesQuerySchema } from '../schemas/project-files.ts'
import {
  projectMcpListSchema,
  projectMcpServerParamsSchema,
  projectMcpServerSchema,
  projectMcpVariablesBodySchema,
  projectTrustApproveBodySchema,
  projectTrustItemParamsSchema,
  projectTrustListSchema,
} from '../schemas/project-trust.ts'
import {
  projectBrowseQuerySchema,
  projectBrowseSchema,
  projectCreateSchema,
  projectSummarySchema,
  projectUpdateSchema,
} from '../schemas/projects.ts'
import {
  credentialsUpdateSchema,
  providerSummarySchema,
  providerTestBodySchema,
  providerTestResultSchema,
  providerUpdateSchema,
} from '../schemas/providers.ts'
import { queueAddBodySchema, queueItemSchema, queueListSchema } from '../schemas/queue.ts'
import {
  shareCreateSchema,
  sharesQuerySchema,
  shareSummarySchema,
  shareUpdateSchema,
  shareViewSchema,
} from '../schemas/shares.ts'
import { shellRuleCreateSchema, shellRuleListSchema, shellRuleSchema } from '../schemas/shell-rules.ts'
import {
  authStatusSchema,
  healthSchema,
  loginBodySchema,
  passwordUpdateSchema,
  settingsSchema,
  settingsUpdateSchema,
} from '../schemas/system.ts'
import {
  commandsQuerySchema,
  commandSummarySchema,
  mcpServerInputSchema,
  mcpServerSchema,
  mcpServerUpdateSchema,
  toolSummarySchema,
  toolUpdateSchema,
} from '../schemas/tools.ts'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Success response of a route: a zod schema = JSON body; `'empty'` = 204; `'sse'` = `text/event-stream` of
 * `ServerEvent`s; `'ui-message-stream'` = AI SDK UI message stream; `'binary'` = raw bytes.
 */
export type ApiResponseSpec = z.ZodType | 'empty' | 'sse' | 'ui-message-stream' | 'binary'

/** Route modules = camelCase of the server route module files (`plugin-install.ts` -> `pluginInstall`). */
export const API_MODULES = [
  'health',
  'auth',
  'settings',
  'events',
  'providers',
  'credentials',
  'models',
  'icons',
  'chats',
  'chat',
  'files',
  'tools',
  'mcp',
  'commands',
  'plugins',
  'pluginInstall',
  'pluginDrafts',
  'pluginFiles',
  'data',
  'audio',
  'projects',
  'keys',
  'changes',
  'shellRules',
  'chatQueue',
  'projectFiles',
  'customizations',
  'memory',
  'chatTasks',
  'hooks',
  'projectTrust',
  'projectMcp',
  'shares',
  'marketplaces',
  'claudeImport',
  'projectDefinitions',
] as const
export type ApiModule = (typeof API_MODULES)[number]

export interface ApiRouteDef {
  /** The key prefix; server route module file = kebab-case of it (`plugin-install.ts`). */
  module: ApiModule
  method: HttpMethod
  /** Relative to `/api`, Hono syntax (`/chats/:id`); a trailing `*` is the rest path bound to `params.path`. */
  path: `/${string}`
  /** No session required (default: session required). */
  public?: true
  /**
   * Always requires fresh auth when a password is set. Conditional cases (`mcp.create` / `mcp.update` with stdio,
   * `pluginInstall.install` of a plugin that requires trust, `pluginDrafts.create` / `pluginDrafts.updateManifest`
   * with a stdio MCP server, `plugins.reload` and `pluginFiles.write` / `pluginFiles.remove` of code plugins, since
   * Phase 11 `hooks.update` unless the body only turns the hook off, and since Phase 12 `pluginInstall.install` of a
   * Claude Code plugin that runs anything) are enforced by the server only.
   */
  fresh?: true
  /** Path params. */
  params?: z.ZodType
  query?: z.ZodType
  /** JSON body. */
  body?: z.ZodType
  /**
   * Multipart fields other than the file part named `file`; a route with `form` accepts multipart (and JSON too
   * when `body` is also set).
   */
  form?: z.ZodType
  response: ApiResponseSpec
  /** Success status; default 200, 204 for `'empty'`. */
  status?: 200 | 201 | 204
}

/** Every endpoint of API.md (132 routes), keyed `<module>.<action>`. */
export const apiRoutes = {
  // health.ts
  'health.get': { module: 'health', method: 'GET', path: '/health', public: true, response: healthSchema },

  // auth.ts
  'auth.status': { module: 'auth', method: 'GET', path: '/auth/status', public: true, response: authStatusSchema },
  'auth.login': { module: 'auth', method: 'POST', path: '/auth/login', public: true, body: loginBodySchema, response: authStatusSchema },
  'auth.logout': { module: 'auth', method: 'POST', path: '/auth/logout', public: true, response: 'empty' },
  'auth.setPassword': { module: 'auth', method: 'PUT', path: '/auth/password', fresh: true, body: passwordUpdateSchema, response: authStatusSchema },

  // settings.ts
  'settings.get': { module: 'settings', method: 'GET', path: '/settings', response: settingsSchema },
  'settings.update': { module: 'settings', method: 'PUT', path: '/settings', body: settingsUpdateSchema, response: settingsSchema },

  // events.ts
  'events.stream': { module: 'events', method: 'GET', path: '/events', response: 'sse' },

  // providers.ts
  'providers.list': { module: 'providers', method: 'GET', path: '/providers', response: listResponseSchema(providerSummarySchema) },
  'providers.update': { module: 'providers', method: 'PATCH', path: '/providers/:id', params: providerParamsSchema, body: providerUpdateSchema, response: providerSummarySchema },
  'providers.test': { module: 'providers', method: 'POST', path: '/providers/:id/test', params: providerParamsSchema, body: providerTestBodySchema, response: providerTestResultSchema },

  // credentials.ts
  'credentials.set': { module: 'credentials', method: 'PUT', path: '/providers/:id/credentials', params: providerParamsSchema, body: credentialsUpdateSchema, response: providerSummarySchema },
  'credentials.clear': { module: 'credentials', method: 'DELETE', path: '/providers/:id/credentials', params: providerParamsSchema, response: providerSummarySchema },

  // models.ts
  'models.list': { module: 'models', method: 'GET', path: '/models', query: modelsQuerySchema, response: listResponseSchema(catalogModelSchema) },
  'models.refresh': { module: 'models', method: 'POST', path: '/providers/:id/models/refresh', params: providerParamsSchema, response: listResponseSchema(catalogModelSchema) },
  'models.updatePrefs': { module: 'models', method: 'PUT', path: '/model-prefs', body: modelPrefsUpdateSchema, response: catalogModelSchema },
  'models.addCustom': { module: 'models', method: 'POST', path: '/custom-models', body: customModelInputSchema, response: catalogModelSchema, status: 201 },
  'models.removeCustom': { module: 'models', method: 'DELETE', path: '/custom-models', query: customModelKeySchema, response: 'empty' },

  // icons.ts
  'icons.list': { module: 'icons', method: 'GET', path: '/icons/lobe', public: true, response: lobeIconListSchema },
  'icons.get': { module: 'icons', method: 'GET', path: '/icons/lobe/:slug', public: true, params: iconParamsSchema, response: 'binary' },

  // chats.ts
  'chats.list': { module: 'chats', method: 'GET', path: '/chats', query: chatsQuerySchema, response: cursorPageSchema(chatSummarySchema) },
  'chats.create': { module: 'chats', method: 'POST', path: '/chats', body: chatCreateSchema, response: chatDetailSchema, status: 201 },
  'chats.get': { module: 'chats', method: 'GET', path: '/chats/:id', params: chatParamsSchema, response: chatDetailSchema },
  'chats.update': { module: 'chats', method: 'PATCH', path: '/chats/:id', params: chatParamsSchema, body: chatUpdateSchema, response: chatSummarySchema },
  'chats.remove': { module: 'chats', method: 'DELETE', path: '/chats/:id', params: chatParamsSchema, response: 'empty' },
  'chats.export': { module: 'chats', method: 'GET', path: '/chats/:id/export', params: chatParamsSchema, query: chatExportQuerySchema, response: 'binary' },
  'chats.switchBranch': { module: 'chats', method: 'POST', path: '/chats/:id/branch', params: chatParamsSchema, body: chatBranchBodySchema, response: chatDetailSchema },
  'chats.deleteMessage': { module: 'chats', method: 'DELETE', path: '/chats/:id/messages/:messageId', params: chatMessageParamsSchema, response: chatDetailSchema },

  // chat.ts
  'chat.send': { module: 'chat', method: 'POST', path: '/chat', body: chatRequestBodySchema, response: 'ui-message-stream' },
  'chat.resume': { module: 'chat', method: 'GET', path: '/chat/:id/stream', params: chatParamsSchema, response: 'ui-message-stream' },
  'chat.stop': { module: 'chat', method: 'POST', path: '/chat/:id/stop', params: chatParamsSchema, response: chatStopResultSchema },

  // files.ts
  'files.upload': { module: 'files', method: 'POST', path: '/files', form: fileUploadFormSchema, response: fileRefSchema, status: 201 },
  'files.get': { module: 'files', method: 'GET', path: '/files/:id', params: fileParamsSchema, response: 'binary' },

  // tools.ts
  'tools.list': { module: 'tools', method: 'GET', path: '/tools', response: listResponseSchema(toolSummarySchema) },
  'tools.update': { module: 'tools', method: 'PATCH', path: '/tools/:name', params: toolParamsSchema, body: toolUpdateSchema, response: toolSummarySchema },

  // mcp.ts
  'mcp.list': { module: 'mcp', method: 'GET', path: '/mcp', response: listResponseSchema(mcpServerSchema) },
  'mcp.create': { module: 'mcp', method: 'POST', path: '/mcp', body: mcpServerInputSchema, response: mcpServerSchema, status: 201 },
  'mcp.update': { module: 'mcp', method: 'PATCH', path: '/mcp/:id', params: mcpServerParamsSchema, body: mcpServerUpdateSchema, response: mcpServerSchema },
  'mcp.remove': { module: 'mcp', method: 'DELETE', path: '/mcp/:id', params: mcpServerParamsSchema, response: 'empty' },
  'mcp.reconnect': { module: 'mcp', method: 'POST', path: '/mcp/:id/reconnect', params: mcpServerParamsSchema, response: mcpServerSchema },

  // commands.ts
  'commands.list': { module: 'commands', method: 'GET', path: '/commands', query: commandsQuerySchema, response: listResponseSchema(commandSummarySchema) },

  // plugins.ts
  'plugins.list': { module: 'plugins', method: 'GET', path: '/plugins', response: listResponseSchema(pluginSummarySchema) },
  'plugins.get': { module: 'plugins', method: 'GET', path: '/plugins/:id', params: pluginParamsSchema, response: pluginDetailSchema },
  'plugins.remove': { module: 'plugins', method: 'DELETE', path: '/plugins/:id', params: pluginParamsSchema, query: pluginRemoveQuerySchema, response: 'empty' },
  'plugins.enable': { module: 'plugins', method: 'POST', path: '/plugins/:id/enable', params: pluginParamsSchema, response: pluginDetailSchema },
  'plugins.disable': { module: 'plugins', method: 'POST', path: '/plugins/:id/disable', params: pluginParamsSchema, response: pluginDetailSchema },
  'plugins.reload': { module: 'plugins', method: 'POST', path: '/plugins/:id/reload', params: pluginParamsSchema, response: pluginDetailSchema },
  'plugins.getSettings': { module: 'plugins', method: 'GET', path: '/plugins/:id/settings', params: pluginParamsSchema, response: pluginSettingsViewSchema },
  'plugins.updateSettings': { module: 'plugins', method: 'PUT', path: '/plugins/:id/settings', params: pluginParamsSchema, body: pluginSettingsUpdateSchema, response: pluginSettingsViewSchema },
  'plugins.icon': { module: 'plugins', method: 'GET', path: '/plugins/:id/icon', params: pluginParamsSchema, response: 'binary' },
  'plugins.logs': { module: 'plugins', method: 'GET', path: '/plugins/:id/logs', params: pluginParamsSchema, query: pluginLogsQuerySchema, response: listResponseSchema(pluginLogEntrySchema) },

  // plugin-install.ts
  'pluginInstall.inspect': { module: 'pluginInstall', method: 'POST', path: '/plugins/inspect', body: pluginInspectBodySchema, form: pluginInspectFormSchema, response: pluginInspectionSchema },
  'pluginInstall.install': { module: 'pluginInstall', method: 'POST', path: '/plugins/install', body: pluginInstallBodySchema, form: pluginInstallFormSchema, response: pluginDetailSchema, status: 201 },
  'pluginInstall.trust': { module: 'pluginInstall', method: 'POST', path: '/plugins/:id/trust', fresh: true, params: pluginParamsSchema, body: pluginTrustBodySchema, response: pluginDetailSchema },
  'pluginInstall.export': { module: 'pluginInstall', method: 'GET', path: '/plugins/:id/export', params: pluginParamsSchema, response: 'binary' },

  // plugin-drafts.ts
  'pluginDrafts.create': { module: 'pluginDrafts', method: 'POST', path: '/plugins', body: pluginDraftSchema, response: pluginDetailSchema, status: 201 },
  'pluginDrafts.test': { module: 'pluginDrafts', method: 'POST', path: '/plugins/drafts/test', body: draftTestRequestSchema, response: draftTestResultSchema },
  'pluginDrafts.updateManifest': { module: 'pluginDrafts', method: 'PUT', path: '/plugins/:id/manifest', params: pluginParamsSchema, body: pluginManifestUpdateSchema, response: pluginDetailSchema },

  // plugin-files.ts
  'pluginFiles.scaffold': { module: 'pluginFiles', method: 'POST', path: '/plugins/scaffold', fresh: true, body: scaffoldRequestSchema, response: pluginDetailSchema, status: 201 },
  'pluginFiles.list': { module: 'pluginFiles', method: 'GET', path: '/plugins/:id/files', params: pluginParamsSchema, response: listResponseSchema(pluginFileEntrySchema) },
  'pluginFiles.read': { module: 'pluginFiles', method: 'GET', path: '/plugins/:id/files/*', params: pluginFileParamsSchema, response: pluginFileContentSchema },
  'pluginFiles.write': { module: 'pluginFiles', method: 'PUT', path: '/plugins/:id/files/*', params: pluginFileParamsSchema, body: pluginFileWriteSchema, response: pluginFileEntrySchema },
  'pluginFiles.remove': { module: 'pluginFiles', method: 'DELETE', path: '/plugins/:id/files/*', params: pluginFileParamsSchema, response: 'empty' },
  'pluginFiles.build': { module: 'pluginFiles', method: 'POST', path: '/plugins/:id/build', fresh: true, params: pluginParamsSchema, body: pluginBuildBodySchema, response: buildResultSchema },

  // data.ts (ADR-024)
  'data.summary': { module: 'data', method: 'GET', path: '/data', response: dataSummarySchema },
  'data.export': { module: 'data', method: 'GET', path: '/data/export', query: dataExportQuerySchema, response: 'binary' },
  'data.import': { module: 'data', method: 'POST', path: '/data/import', form: dataImportFormSchema, response: dataImportResultSchema },
  'data.deleteAll': { module: 'data', method: 'POST', path: '/data/delete', fresh: true, body: dataDeleteBodySchema, response: dataDeleteResultSchema },
  // orphaned file cleanup (ADR-035): a dry run, then the cleanup (no body)
  'data.cleanupPreview': { module: 'data', method: 'GET', path: '/data/cleanup', response: dataCleanupPreviewSchema },
  'data.cleanup': { module: 'data', method: 'POST', path: '/data/cleanup', response: dataCleanupResultSchema },

  // audio.ts (ADR-029): dictation (multipart: the recording in the part `file`) and read-aloud (answers audio bytes)
  'audio.transcribe': { module: 'audio', method: 'POST', path: '/audio/transcriptions', form: audioTranscribeFormSchema, response: audioTranscriptionSchema },
  'audio.speech': { module: 'audio', method: 'POST', path: '/audio/speech', body: audioSpeechBodySchema, response: 'binary' },

  // projects.ts (ADR-031): folders on the server host that chats can belong to; no `GET /projects/:id`, so `/browse`
  // never meets a param route of the same method
  'projects.list': { module: 'projects', method: 'GET', path: '/projects', response: listResponseSchema(projectSummarySchema) },
  'projects.create': { module: 'projects', method: 'POST', path: '/projects', fresh: true, body: projectCreateSchema, response: projectSummarySchema, status: 201 },
  'projects.update': { module: 'projects', method: 'PATCH', path: '/projects/:id', params: projectParamsSchema, body: projectUpdateSchema, response: projectSummarySchema },
  'projects.remove': { module: 'projects', method: 'DELETE', path: '/projects/:id', params: projectParamsSchema, response: 'empty' },
  'projects.browse': { module: 'projects', method: 'GET', path: '/projects/browse', query: projectBrowseQuerySchema, response: projectBrowseSchema },

  // keys.ts (ADR-034): master-key state and the online rotation
  'keys.get': { module: 'keys', method: 'GET', path: '/keys', response: keyStatusSchema },
  'keys.rotate': { module: 'keys', method: 'POST', path: '/keys/rotate', fresh: true, body: keyRotateBodySchema, response: keyRotationResultSchema },

  // changes.ts (ADR-036, ADR-037): the changes panel of a project chat ("This chat" from the change journal, "Git"
  // against HEAD), the per-file revert, the undo of a batch and the rewind; chat-scoped, none needs fresh auth. Each
  // differs from the `chats.ts` routes under `/chats/:id` in its static segments or its segment count.
  'changes.list': { module: 'changes', method: 'GET', path: '/chats/:id/changes', params: chatParamsSchema, response: chatChangesSchema },
  'changes.diff': { module: 'changes', method: 'GET', path: '/chats/:id/changes/diff', params: chatParamsSchema, query: changeDiffQuerySchema, response: fileDiffSchema },
  'changes.git': { module: 'changes', method: 'GET', path: '/chats/:id/git', params: chatParamsSchema, response: gitStatusSchema },
  'changes.revert': { module: 'changes', method: 'POST', path: '/chats/:id/changes/revert', params: chatParamsSchema, body: changeRevertBodySchema, response: restoreResultSchema },
  'changes.undo': { module: 'changes', method: 'POST', path: '/chats/:id/changes/undo', params: chatParamsSchema, body: changeUndoBodySchema, response: restoreResultSchema },
  'changes.rewindPreview': { module: 'changes', method: 'GET', path: '/chats/:id/rewind', params: chatParamsSchema, query: rewindQuerySchema, response: rewindPreviewSchema },
  'changes.rewind': { module: 'changes', method: 'POST', path: '/chats/:id/rewind', params: chatParamsSchema, body: rewindBodySchema, response: restoreResultSchema },

  // shell-rules.ts (ADR-038): command prefixes that run without asking; no fresh auth (a session can already approve
  // its own shell calls)
  'shellRules.list': { module: 'shellRules', method: 'GET', path: '/shell-rules', response: shellRuleListSchema },
  'shellRules.create': { module: 'shellRules', method: 'POST', path: '/shell-rules', body: shellRuleCreateSchema, response: shellRuleSchema, status: 201 },
  'shellRules.remove': { module: 'shellRules', method: 'DELETE', path: '/shell-rules/:id', params: shellRuleParamsSchema, response: 'empty' },

  // chat-queue.ts (ADR-042): the steer queue of a chat, next to `/chat/:id/stream` and `/chat/:id/stop`; a queued
  // message is taken by the running reply at its next step boundary, or starts the next turn
  'chatQueue.list': { module: 'chatQueue', method: 'GET', path: '/chat/:id/queue', params: chatParamsSchema, response: queueListSchema },
  'chatQueue.add': { module: 'chatQueue', method: 'POST', path: '/chat/:id/queue', params: chatParamsSchema, body: queueAddBodySchema, response: queueItemSchema, status: 201 },
  'chatQueue.remove': { module: 'chatQueue', method: 'DELETE', path: '/chat/:id/queue/:itemId', params: chatQueueItemParamsSchema, response: 'empty' },

  // project-files.ts (ADR-042): `@` file mentions of project chats; differs from `/projects/browse` in its segment
  // count, and from `/plugins/:id/files` in its first segment
  'projectFiles.search': { module: 'projectFiles', method: 'GET', path: '/projects/:id/files', params: projectParamsSchema, query: projectFilesQuerySchema, response: projectFileSearchSchema },
  'projectFiles.attach': { module: 'projectFiles', method: 'POST', path: '/projects/:id/files/attach', params: projectParamsSchema, body: projectFileAttachBodySchema, response: fileRefSchema, status: 201 },

  // customizations.ts (ADR-044, ADR-045): the catalog of agents, commands and skills, the bodies of its entries and the
  // personal definitions; `/customizations/source` is static, so it wins over `/customizations/:id`
  'customizations.list': { module: 'customizations', method: 'GET', path: '/customizations', query: customizationsQuerySchema, response: customizationListSchema },
  'customizations.source': { module: 'customizations', method: 'GET', path: '/customizations/source', query: customizationSourceQuerySchema, response: customizationSourceResultSchema },
  'customizations.create': { module: 'customizations', method: 'POST', path: '/customizations', body: customizationCreateSchema, response: customizationSchema, status: 201 },
  'customizations.get': { module: 'customizations', method: 'GET', path: '/customizations/:id', params: customizationParamsSchema, response: customizationSchema },
  'customizations.update': { module: 'customizations', method: 'PATCH', path: '/customizations/:id', params: customizationParamsSchema, body: customizationUpdateSchema, response: customizationSchema },
  'customizations.remove': { module: 'customizations', method: 'DELETE', path: '/customizations/:id', params: customizationParamsSchema, response: 'empty' },

  // memory.ts (ADR-047): Remember, a line for the project file, the project's instructions or the global instructions
  'memory.remember': { module: 'memory', method: 'POST', path: '/memory', body: rememberBodySchema, response: rememberResultSchema },

  // chat-tasks.ts (ADR-046): the background tasks of a chat, next to `/chat/:id/queue`; the chat's Stop never stops them
  'chatTasks.list': { module: 'chatTasks', method: 'GET', path: '/chat/:id/tasks', params: chatParamsSchema, response: backgroundTaskListSchema },
  'chatTasks.stop': { module: 'chatTasks', method: 'POST', path: '/chat/:id/tasks/:taskId/stop', params: chatTaskParamsSchema, response: backgroundTaskSchema },

  // hooks.ts (ADR-048): the hook listing of a scope, the run log and the personal hooks; there is no `GET /hooks/:id`,
  // so `/hooks/runs` never meets a param route of the same method. Creating a hook needs fresh auth; changing one too,
  // unless the body only turns it off (`isHookTurnOff`, enforced by the route, so `hooks.update` has no `fresh` flag)
  'hooks.list': { module: 'hooks', method: 'GET', path: '/hooks', query: hooksQuerySchema, response: hookListSchema },
  'hooks.runs': { module: 'hooks', method: 'GET', path: '/hooks/runs', response: hookRunListSchema },
  'hooks.create': { module: 'hooks', method: 'POST', path: '/hooks', fresh: true, body: hookCreateSchema, response: personalHookSchema, status: 201 },
  'hooks.update': { module: 'hooks', method: 'PATCH', path: '/hooks/:id', params: hookParamsSchema, body: hookUpdateSchema, response: personalHookSchema },
  'hooks.remove': { module: 'hooks', method: 'DELETE', path: '/hooks/:id', params: hookParamsSchema, response: 'empty' },

  // project-trust.ts (ADR-049): the executable items of a project folder and their approvals (approve needs fresh auth;
  // revoke does not); differs from `/projects/:id/files...` in its static third segment
  'projectTrust.list': { module: 'projectTrust', method: 'GET', path: '/projects/:id/trust', params: projectParamsSchema, response: projectTrustListSchema },
  'projectTrust.approve': { module: 'projectTrust', method: 'POST', path: '/projects/:id/trust', fresh: true, params: projectParamsSchema, body: projectTrustApproveBodySchema, response: projectTrustListSchema },
  'projectTrust.revoke': { module: 'projectTrust', method: 'DELETE', path: '/projects/:id/trust/:sha256', params: projectTrustItemParamsSchema, response: projectTrustListSchema },

  // project-mcp.ts (ADR-050): the servers of a project's `.mcp.json` and their variables (setting variables needs fresh
  // auth: a value can change what an approved stdio server runs)
  'projectMcp.list': { module: 'projectMcp', method: 'GET', path: '/projects/:id/mcp', params: projectParamsSchema, response: projectMcpListSchema },
  'projectMcp.setVariables': { module: 'projectMcp', method: 'PUT', path: '/projects/:id/mcp/variables', fresh: true, params: projectParamsSchema, body: projectMcpVariablesBodySchema, response: projectMcpListSchema },
  'projectMcp.reconnect': { module: 'projectMcp', method: 'POST', path: '/projects/:id/mcp/:serverId/reconnect', params: projectMcpServerParamsSchema, response: projectMcpServerSchema },

  // shares.ts (ADR-025): owner routes under `/shares`, public routes under `/share/:token`
  'shares.list': { module: 'shares', method: 'GET', path: '/shares', query: sharesQuerySchema, response: listResponseSchema(shareSummarySchema) },
  'shares.create': { module: 'shares', method: 'POST', path: '/shares', fresh: true, body: shareCreateSchema, response: shareSummarySchema, status: 201 },
  'shares.update': { module: 'shares', method: 'PATCH', path: '/shares/:id', fresh: true, params: shareParamsSchema, body: shareUpdateSchema, response: shareSummarySchema },
  'shares.remove': { module: 'shares', method: 'DELETE', path: '/shares/:id', params: shareParamsSchema, response: 'empty' },
  'shares.view': { module: 'shares', method: 'GET', path: '/share/:token', public: true, params: sharePublicParamsSchema, response: shareViewSchema },
  'shares.file': { module: 'shares', method: 'GET', path: '/share/:token/files/:fileId', public: true, params: shareFileParamsSchema, response: 'binary' },

  // marketplaces.ts (ADR-054): plugin marketplaces (a GitHub repository, a hosted `marketplace.json` or a server folder);
  // adding fetches at once (nothing is stored when that fails); removing keeps the installed plugins; installs go
  // through `pluginInstall` (source `marketplace`)
  'marketplaces.list': { module: 'marketplaces', method: 'GET', path: '/marketplaces', response: marketplaceListSchema },
  'marketplaces.add': { module: 'marketplaces', method: 'POST', path: '/marketplaces', body: marketplaceAddBodySchema, response: marketplaceDetailSchema, status: 201 },
  'marketplaces.get': { module: 'marketplaces', method: 'GET', path: '/marketplaces/:id', params: marketplaceParamsSchema, response: marketplaceDetailSchema },
  'marketplaces.refresh': { module: 'marketplaces', method: 'POST', path: '/marketplaces/:id/refresh', params: marketplaceParamsSchema, response: marketplaceDetailSchema },
  'marketplaces.remove': { module: 'marketplaces', method: 'DELETE', path: '/marketplaces/:id', params: marketplaceParamsSchema, response: 'empty' },

  // claude-import.ts (ADR-055): import from a Claude Code home folder; the plan is built and held by the server (an
  // upload of the picked files or a zip, or a scan of `HF_CLAUDE_HOME`); scanning and applying need fresh auth
  'claudeImport.home': { module: 'claudeImport', method: 'GET', path: '/claude-import/home', response: claudeImportHomeSchema },
  'claudeImport.scan': { module: 'claudeImport', method: 'POST', path: '/claude-import/scan', fresh: true, response: claudeImportPlanSchema },
  'claudeImport.upload': { module: 'claudeImport', method: 'POST', path: '/claude-import/upload', form: claudeImportUploadFormSchema, response: claudeImportPlanSchema },
  'claudeImport.apply': { module: 'claudeImport', method: 'POST', path: '/claude-import/apply', fresh: true, body: claudeImportApplyBodySchema, response: claudeImportApplyResultSchema },

  // project-definitions.ts (ADR-056): a project's definition files, settings `hooks` and `.mcp.json` `mcpServers` edited
  // from the UI; no fresh auth and no idle rule (saving never approves anything); differs from `/projects/:id/files...`
  // in its static third segment
  'projectDefinitions.read': { module: 'projectDefinitions', method: 'GET', path: '/projects/:id/definitions/file', params: projectParamsSchema, query: projectDefinitionQuerySchema, response: projectDefinitionFileSchema },
  'projectDefinitions.write': { module: 'projectDefinitions', method: 'PUT', path: '/projects/:id/definitions/file', params: projectParamsSchema, body: projectDefinitionWriteBodySchema, response: projectDefinitionWriteResultSchema },
  'projectDefinitions.remove': { module: 'projectDefinitions', method: 'DELETE', path: '/projects/:id/definitions/file', params: projectParamsSchema, query: projectDefinitionRemoveQuerySchema, response: 'empty' },
} as const satisfies Record<string, ApiRouteDef>

export type ApiRoutes = typeof apiRoutes
export type ApiRouteKey = keyof ApiRoutes

/** Every route key, in table order. */
export const API_ROUTE_KEYS = Object.keys(apiRoutes) as ApiRouteKey[]

/** Success status of a route: `status`, else 204 for `'empty'`, else 200. */
export function routeSuccessStatus(route: ApiRouteDef): 200 | 201 | 204 {
  return route.status ?? (route.response === 'empty' ? 204 : 200)
}

/** True when the route answers with a JSON body described by a zod schema. */
export function isJsonResponse(route: ApiRouteDef): route is ApiRouteDef & { response: z.ZodType } {
  return typeof route.response !== 'string'
}

export interface ApiRouteMatch {
  key: ApiRouteKey
  route: ApiRouteDef
  /** Decoded path params (`path` for the rest path of `/plugins/:id/files/*`). */
  params: Record<string, string>
}

function matchPath(template: string, segments: readonly string[]): Record<string, string> | null {
  const parts = template.split('/').slice(1)
  const params: Record<string, string> = {}
  for (const [index, part] of parts.entries()) {
    if (part === '*') {
      const rest = segments.slice(index)
      if (rest.length === 0 || rest.includes(''))
        return null
      params.path = rest.join('/')
      return params
    }
    const segment = segments[index]
    if (segment === undefined || segment === '')
      return null
    if (part.startsWith(':'))
      params[part.slice(1)] = segment
    else if (part !== segment)
      return null
  }
  return parts.length === segments.length ? params : null
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return null
  }
}

/**
 * Finds the route of a request. `path` is relative to `/api` (`/plugins/x/files/src/index.ts`), without query string;
 * static segments win over params. Returns `null` for unknown routes or malformed percent-encoding.
 */
export function matchApiRoute(method: string, path: string): ApiRouteMatch | null {
  const upper = method.toUpperCase()
  const decoded: string[] = []
  for (const segment of path.split('/').slice(1)) {
    const value = decodeSegment(segment)
    if (value === null)
      return null
    decoded.push(value)
  }
  let best: { match: ApiRouteMatch, score: number } | null = null
  for (const key of API_ROUTE_KEYS) {
    const route: ApiRouteDef = apiRoutes[key]
    if (route.method !== upper)
      continue
    const params = matchPath(route.path, decoded)
    if (!params)
      continue
    const score = route.path.split('/').filter(part => part !== '' && !part.startsWith(':') && part !== '*').length
    if (!best || score > best.score)
      best = { match: { key, route, params }, score }
  }
  return best?.match ?? null
}
