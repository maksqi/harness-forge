// The URL guard of MCP OAuth (W14.1-T4): the authorization-server rule, the authorization URL and the resource check.
import { describe, expect, it } from 'vitest'
import {
  checkAuthorizationUrl,
  isAllowedAuthorizationServer,
  isLoopbackHostname,
  isMcpOAuthGuardError,
  isResourceAllowed,
  McpOAuthGuardError,
  NO_OAUTH_MESSAGE,
  selectResourceUrl,
  validateAuthorizationServerUrl,
  withoutQuery,
} from './guard.ts'

const PUBLIC_MCP = 'https://mcp.example.com/mcp'
const LOOPBACK_MCP = 'http://127.0.0.1:4100/mcp'

function reasonOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  }
  catch (error) {
    return isMcpOAuthGuardError(error) ? error.reason : 'other'
  }
}

describe('validateAuthorizationServerURL', () => {
  it.each([
    ['https on a public host', PUBLIC_MCP, 'https://auth.example.com/'],
    ['the MCP server\'s own origin', PUBLIC_MCP, 'https://mcp.example.com/'],
    ['the own origin over http', 'http://mcp.example.com/mcp', 'http://mcp.example.com/oauth'],
    ['loopback to loopback', LOOPBACK_MCP, 'http://localhost:4200/'],
    ['loopback to another loopback port', LOOPBACK_MCP, 'http://127.0.0.1:4200/'],
    ['a LAN server on its own origin', 'http://192.168.1.20:8080/mcp', 'http://192.168.1.20:8080/'],
  ])('allows %s', (_label, server, authorizationServer) => {
    expect(isAllowedAuthorizationServer(server, authorizationServer)).toBe(true)
    expect(() => validateAuthorizationServerUrl(server, authorizationServer)).not.toThrow()
  })

  it.each([
    ['the cloud metadata address over http', PUBLIC_MCP, 'http://169.254.169.254/'],
    ['the cloud metadata address over https', PUBLIC_MCP, 'https://169.254.169.254/'],
    ['a 10.x address over http', PUBLIC_MCP, 'http://10.0.0.1/'],
    ['a 10.x address over https', PUBLIC_MCP, 'https://10.0.0.1/'],
    ['a 10.x address for a loopback server', LOOPBACK_MCP, 'http://10.0.0.1/'],
    ['an http authorization server', PUBLIC_MCP, 'http://auth.example.com/'],
    ['loopback for a public server', PUBLIC_MCP, 'https://127.0.0.1/'],
    ['localhost for a public server', PUBLIC_MCP, 'https://localhost/'],
    ['an IPv6 unique local address', PUBLIC_MCP, 'https://[fd00::1]/'],
    ['a .internal name', PUBLIC_MCP, 'https://auth.corp.internal/'],
    ['credentials in the URL', PUBLIC_MCP, 'https://user:pass@auth.example.com/'],
    ['a javascript: URL', PUBLIC_MCP, 'javascript:alert(1)'],
    ['no URL', PUBLIC_MCP, 'not a url'],
  ])('refuses %s', (_label, server, authorizationServer) => {
    expect(isAllowedAuthorizationServer(server, authorizationServer)).toBe(false)
    expect(reasonOf(() => validateAuthorizationServerUrl(server, authorizationServer))).toBe('authorization-server')
  })

  it('knows the loopback names', () => {
    expect(['localhost', 'app.localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]', 'LOCALHOST.'].every(isLoopbackHostname)).toBe(true)
    expect(['10.0.0.1', '169.254.169.254', 'example.com', '::ffff:10.0.0.1'].some(isLoopbackHostname)).toBe(false)
  })
})

describe('the authorization URL handed to the browser', () => {
  it('must be http(s) without credentials', () => {
    expect(checkAuthorizationUrl('https://auth.example.com/authorize?state=x')).toBe('https://auth.example.com/authorize?state=x')
    expect(checkAuthorizationUrl(new URL('http://127.0.0.1:4100/authorize'))).toBe('http://127.0.0.1:4100/authorize')
    for (const url of ['javascript:alert(document.cookie)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:secret@auth.example.com/authorize', 'nope'])
      expect(reasonOf(() => checkAuthorizationUrl(url)), url).toBe('authorization-url')
  })
})

describe('the protected resource', () => {
  it('follows the SDK rule: same origin and a path prefix', () => {
    expect(isResourceAllowed('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp')).toBe(true)
    expect(isResourceAllowed('https://mcp.example.com/mcp/sub', 'https://mcp.example.com/mcp')).toBe(true)
    expect(isResourceAllowed('https://mcp.example.com/', 'https://mcp.example.com/mcp')).toBe(false)
    expect(isResourceAllowed('https://mcp.example.com/mcp', 'https://other.example.com/mcp')).toBe(false)
    expect(selectResourceUrl('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp').href).toBe('https://mcp.example.com/mcp')
  })

  it('no metadata is "does not support OAuth"; another resource is refused', () => {
    expect(reasonOf(() => selectResourceUrl(PUBLIC_MCP, undefined))).toBe('no-oauth')
    expect(new McpOAuthGuardError('no-oauth').message).toBe(NO_OAUTH_MESSAGE)
    expect(NO_OAUTH_MESSAGE).toBe('This server asked for sign-in but does not support OAuth.')
    expect(reasonOf(() => selectResourceUrl(PUBLIC_MCP, 'https://evil.example.com/mcp'))).toBe('resource')
  })
})

describe('withoutQuery', () => {
  it('drops the query and the fragment', () => {
    expect(withoutQuery('https://auth.example.com/authorize?code_challenge=abc&state=def#x')).toBe('https://auth.example.com/authorize')
    expect(withoutQuery('not a url?state=1')).toBe('not a url')
  })
})
