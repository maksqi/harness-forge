// App factory (ARCHITECTURE.md section 3): the full middleware chain and every route module under `/api`, then the
// SPA. FROZEN after Phase 0: owners implement the middleware and route modules behind the export names imported here.
//
// Chain (every request):   request id -> access log -> secure headers
// `/api/*` only:           Origin check (non-GET) -> session auth (public routes skipped) -> fresh auth (`fresh`
//                          routes) -> body limit -> route modules -> `not_found` for unmatched `/api/*`
// then:                    SPA static files (`http/static.ts`)
// finally:                 `notFound` -> `not_found` envelope; `onError` -> `HarnessError` envelope
import type { AppContext, AppEnv, RouteFactory } from './http/types.ts'
import type { AppDeps } from './types.ts'
import { HarnessError } from '@harness-forge/shared'
import { Hono } from 'hono'
import { accessLogMiddleware } from './http/middleware/access-log.ts'
import { bodyLimitMiddleware } from './http/middleware/body-limit.ts'
import { createErrorHandler, createNotFoundHandler } from './http/middleware/error-handler.ts'
import { freshAuthMiddleware } from './http/middleware/fresh-auth.ts'
import { originCheckMiddleware } from './http/middleware/origin-check.ts'
import { requestIdMiddleware } from './http/middleware/request-id.ts'
import { secureHeadersMiddleware } from './http/middleware/secure-headers.ts'
import { sessionAuthMiddleware } from './http/middleware/session-auth.ts'
import { API_BASE_PATH } from './http/route-match.ts'
import { createAudioRoutes } from './http/routes/audio.ts'
import { createAuthRoutes } from './http/routes/auth.ts'
import { createChangesRoutes } from './http/routes/changes.ts'
import { createChatQueueRoutes } from './http/routes/chat-queue.ts'
import { createChatTasksRoutes } from './http/routes/chat-tasks.ts'
import { createChatRoutes } from './http/routes/chat.ts'
import { createChatsRoutes } from './http/routes/chats.ts'
import { createCommandsRoutes } from './http/routes/commands.ts'
import { createCredentialsRoutes } from './http/routes/credentials.ts'
import { createCustomizationsRoutes } from './http/routes/customizations.ts'
import { createDataRoutes } from './http/routes/data.ts'
import { createEventsRoutes } from './http/routes/events.ts'
import { createFilesRoutes } from './http/routes/files.ts'
import { createHealthRoutes } from './http/routes/health.ts'
import { createHooksRoutes } from './http/routes/hooks.ts'
import { createIconsRoutes } from './http/routes/icons.ts'
import { createKeysRoutes } from './http/routes/keys.ts'
import { createMcpRoutes } from './http/routes/mcp.ts'
import { createMemoryRoutes } from './http/routes/memory.ts'
import { createModelsRoutes } from './http/routes/models.ts'
import { createPluginDraftsRoutes } from './http/routes/plugin-drafts.ts'
import { createPluginFilesRoutes } from './http/routes/plugin-files.ts'
import { createPluginInstallRoutes } from './http/routes/plugin-install.ts'
import { createPluginsRoutes } from './http/routes/plugins.ts'
import { createProjectFilesRoutes } from './http/routes/project-files.ts'
import { createProjectMcpRoutes } from './http/routes/project-mcp.ts'
import { createProjectTrustRoutes } from './http/routes/project-trust.ts'
import { createProjectsRoutes } from './http/routes/projects.ts'
import { createProvidersRoutes } from './http/routes/providers.ts'
import { createSettingsRoutes } from './http/routes/settings.ts'
import { createSharesRoutes } from './http/routes/shares.ts'
import { createShellRulesRoutes } from './http/routes/shell-rules.ts'
import { createToolsRoutes } from './http/routes/tools.ts'
import { createStaticRoutes } from './http/static.ts'

/**
 * The 33 route modules (`ApiModule` of the route table -> `http/routes/<kebab-case>.ts`), in mount order. Modules
 * with static `/plugins/<word>` paths are mounted before `plugins` (`/plugins/:id...`); no route shadows another
 * (they differ in method, segment count or static segments, API.md 8), the order is a second line of defense. `shares`
 * also serves the public `/share/:token` routes; `changes` (Phase 8) serves chat-scoped routes under `/chats/:id/...`;
 * `chatQueue` (Phase 9) serves `/chat/:id/queue...` next to `chat`, `projectFiles` (Phase 9) `/projects/:id/files...`;
 * Phase 10: `customizations` (`/customizations/source` is registered before `/customizations/:id` inside the module),
 * `memory` (`/memory`) and `chatTasks` (`/chat/:id/tasks...`); Phase 11: `hooks` (`/hooks...`; no `GET /hooks/:id`, so
 * `/hooks/runs` is never taken for an id), `projectTrust` (`/projects/:id/trust...`) and `projectMcp`
 * (`/projects/:id/mcp...`), which differ from `/projects/:id` and `/projects/:id/files...` in their static third segment
 * or their segment count.
 */
export const ROUTE_MODULES = {
  health: createHealthRoutes,
  auth: createAuthRoutes,
  settings: createSettingsRoutes,
  events: createEventsRoutes,
  providers: createProvidersRoutes,
  credentials: createCredentialsRoutes,
  models: createModelsRoutes,
  icons: createIconsRoutes,
  chats: createChatsRoutes,
  chat: createChatRoutes,
  files: createFilesRoutes,
  tools: createToolsRoutes,
  mcp: createMcpRoutes,
  commands: createCommandsRoutes,
  data: createDataRoutes,
  audio: createAudioRoutes,
  projects: createProjectsRoutes,
  keys: createKeysRoutes,
  changes: createChangesRoutes,
  shellRules: createShellRulesRoutes,
  chatQueue: createChatQueueRoutes,
  projectFiles: createProjectFilesRoutes,
  customizations: createCustomizationsRoutes,
  memory: createMemoryRoutes,
  chatTasks: createChatTasksRoutes,
  hooks: createHooksRoutes,
  projectTrust: createProjectTrustRoutes,
  projectMcp: createProjectMcpRoutes,
  shares: createSharesRoutes,
  pluginInstall: createPluginInstallRoutes,
  pluginDrafts: createPluginDraftsRoutes,
  pluginFiles: createPluginFilesRoutes,
  plugins: createPluginsRoutes,
} as const satisfies Record<string, RouteFactory>

/** Message prefix of the `not_found` answered for an `/api/*` request that matches no route (tests detect it). */
export const UNKNOWN_API_ROUTE_MESSAGE = 'Unknown API route'

/** Last handler of the `/api` sub-app: an unmatched `/api/*` request is a `not_found` envelope, never the SPA. */
function unknownApiRoute(c: AppContext): never {
  throw new HarnessError({ code: 'not_found', message: `${UNKNOWN_API_ROUTE_MESSAGE}: ${c.req.method} ${c.req.path}` })
}

/** The `/api` sub-app: API middleware, every route module, then `not_found` for anything unmatched. */
export function createApiApp(deps: AppDeps): Hono<AppEnv> {
  const api = new Hono<AppEnv>()
  api.use('*', originCheckMiddleware(deps))
  api.use('*', sessionAuthMiddleware(deps))
  api.use('*', freshAuthMiddleware(deps))
  api.use('*', bodyLimitMiddleware(deps))
  for (const createRoutes of Object.values(ROUTE_MODULES))
    api.route('/', createRoutes(deps))
  api.all('*', unknownApiRoute)
  return api
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requestIdMiddleware(deps))
  app.use('*', accessLogMiddleware(deps))
  app.use('*', secureHeadersMiddleware(deps))
  app.route(API_BASE_PATH, createApiApp(deps))
  app.route('/', createStaticRoutes(deps))
  app.notFound(createNotFoundHandler(deps))
  app.onError(createErrorHandler(deps))
  return app
}
