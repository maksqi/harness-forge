// The OAuth MCP fixture of the e2e specs (Phase 14, W14.11): a re-export of the frozen fixture of the server tests and
// gate probes (`apps/server/src/mcp/__fixtures__/oauth-mcp-server.mjs`, C53; its module comment is the reference for the
// endpoints, tools, prompts, resources, counters and toggles), so the specs, the unit tests and the probes share one
// implementation. Plain ESM (no TypeScript, nothing of the server but this file), built on `@modelcontextprotocol/sdk`
// (a root dev dependency) and Node built-ins; loopback only; no file writes. The specs start it in the Playwright worker
// with `startOAuthMcpServer({ host: '127.0.0.1', toggles })` (`startOAuthFixture` of `helpers/mcp.ts`): the app runs on
// `localhost`, so the sign-in redirect between the two is a genuinely cross-site navigation. The script mode (`--port`,
// toggles, `--stdio`) is the original's: `node apps/server/src/mcp/__fixtures__/oauth-mcp-server.mjs --port 0`.
export * from '../../apps/server/src/mcp/__fixtures__/oauth-mcp-server.mjs'
