// MCP resource routes (API.md 5.39, ADR-061) - Phase 14 stubs (501). Owner: W14.2. Keep the export name
// `createMcpResourcesRoutes`. Thin: validate, call the MCP managers' resource members (`mcp/resources.ts`).
//
// - `GET /mcp/resources?projectId&q&limit`: the resources of the connected global servers and, with `projectId`, of
//   that project's connected servers (a project server shadows a global one with the same id; resource templates are
//   not listed); ranked by `q`; answers `{ items, truncated, unavailable }` (`unavailable`: the servers of the scope
//   that are not connected, with their status). `404` unknown project. Never starts a sign-in.
// - `POST /mcp/resources/attach` (`201`, body `{ serverId, uri, projectId? }`): reads the resource once and stores it as
//   an upload (at most 5 MiB, else `413`; text as `text/plain` or the server's `text/*`, several text contents joined,
//   binary only images and PDF, else `400`); answers the upload's `FileRef`. `404` unknown server or project, `409`
//   `needs-auth` when the server must be signed in first, `502` `provider_unreachable` when it is not connected.
// - Resource contents are untrusted; never logged.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, mcpResourceAttachBodySchema, mcpResourceQuerySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createMcpResourcesRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['mcpResources.list'].path, validate('query', mcpResourceQuerySchema), notImplemented('mcpResources.list'))
  app.post(apiRoutes['mcpResources.attach'].path, validate('json', mcpResourceAttachBodySchema), notImplemented('mcpResources.attach'))
  return app
}
