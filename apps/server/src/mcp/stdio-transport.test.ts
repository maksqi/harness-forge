import type { McpTestApp } from './__fixtures__/harness.ts'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createMCPClient } from '@ai-sdk/mcp'
import { afterEach, describe, expect, it } from 'vitest'
import { liveShellGroups } from '../workspace/shell.ts'
import { createMcpTestApp, ECHO_SERVER_PATH, MCP_MIN_PATH, mcpMinStdio, outputJson, outputText, processAlive, readMcpPids, waitFor } from './__fixtures__/harness.ts'
import { ChildProcessMcpTransport, createStdioTransport, stdioEnvironment } from './stdio-transport.ts'

const posix = process.platform !== 'win32'
const temps: string[] = []
const strays: number[] = []
let app: McpTestApp | null = null

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await app?.close()
  app = null
  // A failed assertion must not leave a fixture behind.
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {}
  }
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true })
})

/** Waits until both processes are gone (an orphan is reaped by init a moment after it died). */
async function expectDead(...pids: Array<number | null>): Promise<void> {
  for (const pid of pids) {
    expect(pid).toEqual(expect.any(Number))
    await waitFor(() => !processAlive(pid!), 5000)
  }
}

/** A transport running `mcp-min.mjs` with `args`, its pids recorded in a temp pid file. */
async function minTransport(args: string[], options: { killGraceMs?: number, processGroup?: boolean } = {}) {
  const dir = await tempFolder()
  const pidFile = join(dir, 'pids')
  const transport = new ChildProcessMcpTransport({
    command: process.execPath,
    args: [MCP_MIN_PATH, '--pid-file', pidFile, ...args],
    env: { TOKEN: 'secret-token-1' },
    cwd: dir,
    killGraceMs: options.killGraceMs ?? 500,
    ...(options.processGroup === undefined ? {} : { processGroup: options.processGroup }),
  })
  return { transport, pidFile, dir }
}

describe('stdioEnvironment', () => {
  it('inherits only the minimal POSIX set and lets declared values win', () => {
    const parent = { PATH: '/bin', HOME: '/home/u', HF_PASSWORD: 'secret', OPENAI_API_KEY: 'sk-1', USER: 'u', BASH_FUNC: '() { :; }', SHELL: '() { x; }' }
    expect(stdioEnvironment({ HOME: '/custom', TOKEN: 't' }, parent, 'linux')).toEqual({ HOME: '/custom', TOKEN: 't', PATH: '/bin', USER: 'u' })
  })

  it('uses the Windows list on win32 (case-insensitive override)', () => {
    const parent = { PATH: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', HOME: 'x', HF_DATA_DIR: 'd' }
    expect(stdioEnvironment({ Path: 'D:\\bin' }, parent, 'win32')).toEqual({ Path: 'D:\\bin', SYSTEMROOT: 'C:\\Windows' })
  })
})

describe('childProcessMcpTransport', () => {
  it('talks JSON-RPC over stdio, forwards stderr, reports an unexpected exit and terminates on close', async () => {
    const stderr: string[] = []
    const exits: Array<{ code: number | null }> = []
    let transport = new ChildProcessMcpTransport({
      command: process.execPath,
      args: [ECHO_SERVER_PATH],
      env: { MARKER: 'yes' },
      onStderr: line => stderr.push(line),
      onExit: exit => exits.push(exit),
    })
    let client = await createMCPClient({ transport })
    const pid = transport.pid
    expect(pid).toEqual(expect.any(Number))
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toContain('echo')
    expect(outputJson(await client.callTool({ name: 'env', arguments: { name: 'MARKER' } }))).toEqual({ value: 'yes' })
    await client.callTool({ name: 'stderr', arguments: { text: 'line one' } })
    await waitFor(() => stderr.includes('line one'))
    await client.close()
    await waitFor(() => !processAlive(pid!))
    expect(exits).toEqual([])

    transport = new ChildProcessMcpTransport({ command: process.execPath, args: [ECHO_SERVER_PATH], env: {}, onExit: exit => exits.push(exit) })
    client = await createMCPClient({ transport })
    await client.callTool({ name: 'exit' })
    await waitFor(() => exits.length === 1)
    expect(exits[0]).toMatchObject({ code: 3 })
    await client.close()
  })

  it('rejects start() when the command does not exist', async () => {
    const transport = new ChildProcessMcpTransport({ command: '/nonexistent/harness-forge-binary', args: [], env: {} })
    await expect(transport.start()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(transport.close()).resolves.toBeUndefined()
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow('not running')
    expect(transport.processGroupId).toBeNull()
  })

  it('kills a child that ignores SIGTERM after the grace period', async () => {
    const script = 'process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000); process.stderr.write("ready\\n")'
    const lines: string[] = []
    const transport = new ChildProcessMcpTransport({ command: process.execPath, args: ['-e', script], env: {}, killGraceMs: 200, onStderr: line => lines.push(line) })
    await transport.start()
    const pid = transport.pid!
    await waitFor(() => lines.includes('ready'))
    const started = Date.now()
    await transport.close()
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    expect(processAlive(pid)).toBe(false)
  })
})

describe('the echo server fixture (Phase 11: env without a name)', () => {
  it('lists every variable name and never a value', async () => {
    const transport = new ChildProcessMcpTransport({ command: process.execPath, args: [ECHO_SERVER_PATH], env: { DECLARED: 'declared-secret-value' } })
    const client = await createMCPClient({ transport })
    try {
      const { names } = outputJson<{ names: string[] }>(await client.callTool({ name: 'env', arguments: {} }))
      expect(names).toContain('DECLARED')
      expect(names).toEqual([...names].sort())
      expect(names.filter(name => name.startsWith('HF_'))).toEqual([])
      expect(JSON.stringify(names)).not.toContain('declared-secret-value')
      expect(outputJson(await client.callTool({ name: 'pid', arguments: {} }))).toEqual({ pid: transport.pid })
    }
    finally {
      await client.close()
    }
  })
})

describe('the dependency-free fixture mcp-min.mjs (Phase 11, C38-T3)', () => {
  it('answers initialize, tools/list and tools/call echo / pid / env', async () => {
    const { transport, dir } = await minTransport(['--name', 'local-echo'])
    const client = await createMCPClient({ transport })
    try {
      expect(client.serverInfo).toMatchObject({ name: 'local-echo', version: '1.0.0' })
      const { tools } = await client.listTools()
      expect(tools.map(tool => tool.name)).toEqual(['echo', 'pid', 'env'])
      expect(outputText(await client.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('local-echo echo: hi')
      expect(outputJson(await client.callTool({ name: 'pid', arguments: {} }))).toEqual({ pid: transport.pid, grandchild: null })
      expect(outputJson(await client.callTool({ name: 'env', arguments: { name: 'TOKEN' } }))).toEqual({ value: 'secret-token-1' })
      expect(outputJson(await client.callTool({ name: 'env', arguments: { name: 'HF_PASSWORD' } }))).toEqual({ value: null })
      const { names } = outputJson<{ names: string[] }>(await client.callTool({ name: 'env', arguments: {} }))
      expect(names).toContain('TOKEN')
      expect(names.filter(name => name.startsWith('HF_'))).toEqual([])
      await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown tool/)
      // No marker without --marker.
      expect((await readdir(dir)).filter(file => file.startsWith('.mcp-started-'))).toEqual([])
    }
    finally {
      await client.close()
    }
  })

  it('writes the start marker with --marker (pid, name, TOKEN set, never its value)', async () => {
    const { transport, dir } = await minTransport(['--marker'])
    const client = await createMCPClient({ transport })
    try {
      const marker = `.mcp-started-${transport.pid}`
      expect(await readdir(dir)).toContain(marker)
      const text = await readFile(join(dir, marker), 'utf8')
      expect(JSON.parse(text)).toMatchObject({ pid: transport.pid, name: 'mcp-min', token: 'set' })
      expect(text).not.toContain('secret-token-1')
    }
    finally {
      await client.close()
    }
  })
})

describe.skipIf(!posix)('process group (Phase 11, C38-T2)', () => {
  it('runs every server in its own group by default: closing kills the server and its grandchild', async () => {
    const { transport, pidFile } = await minTransport(['--grandchild'])
    const client = await createMCPClient({ transport })
    const { pid, grandchild } = await readMcpPids(pidFile)
    strays.push(pid, grandchild!)
    expect(transport.processGroupId).toBe(pid)
    expect(liveShellGroups()).toContain(pid)
    expect(outputJson(await client.callTool({ name: 'pid', arguments: {} }))).toEqual({ pid, grandchild })
    expect(processAlive(pid)).toBe(true)
    expect(processAlive(grandchild!)).toBe(true)
    await client.close()
    await expectDead(pid, grandchild)
    expect(transport.processGroupId).toBeNull()
    expect(liveShellGroups()).not.toContain(pid)
  })

  it('escalates to SIGKILL when the server and its grandchild ignore SIGTERM', async () => {
    const { transport, pidFile } = await minTransport(['--grandchild', '--ignore-term'], { killGraceMs: 200 })
    const client = await createMCPClient({ transport })
    const { pid, grandchild } = await readMcpPids(pidFile)
    strays.push(pid, grandchild!)
    // Give the grandchild time to install its SIGTERM handler (a Node process needs a moment to boot).
    await new Promise(resolve => setTimeout(resolve, 800))
    const started = Date.now()
    await client.close()
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    await expectDead(pid, grandchild)
  })

  it('kills both after a failed start (initialize refused): the client closes the transport', async () => {
    const { transport, pidFile } = await minTransport(['--grandchild', '--fail-init'])
    await expect(createMCPClient({ transport })).rejects.toThrow()
    const { pid, grandchild } = await readMcpPids(pidFile)
    strays.push(pid, grandchild!)
    await expectDead(pid, grandchild)
  })

  it('kills the grandchild when the server itself exits (a crashed start)', async () => {
    const { transport, pidFile } = await minTransport(['--grandchild', '--exit-on-init'])
    await expect(createMCPClient({ transport })).rejects.toThrow()
    const { pid, grandchild } = await readMcpPids(pidFile)
    strays.push(pid, grandchild!)
    await expectDead(pid, grandchild)
    await expect(transport.close()).resolves.toBeUndefined()
  })

  it('stops a server that is closed while it is still starting (the pid is known before \'spawn\')', async () => {
    const { transport, pidFile } = await minTransport(['--grandchild'])
    const starting = transport.start()
    const pid = transport.pid
    expect(transport.processGroupId).toBe(pid)
    await transport.close()
    await starting.catch(() => {})
    await expectDead(pid)
    // The grandchild, if the server got that far, was in the same group.
    const grandchild = Number.parseInt((await readFile(pidFile, 'utf8').catch(() => '')).trim().split(/\s+/)[1] ?? '', 10)
    if (Number.isInteger(grandchild) && grandchild > 0) {
      strays.push(grandchild)
      await expectDead(grandchild)
    }
    expect(transport.processGroupId).toBeNull()
  })

  it('processGroup: false keeps the v1.6 behavior: the grandchild outlives the server (the fixture proves the point)', async () => {
    const { transport, pidFile } = await minTransport(['--grandchild'], { processGroup: false })
    const client = await createMCPClient({ transport })
    const { pid, grandchild } = await readMcpPids(pidFile)
    strays.push(pid, grandchild!)
    expect(transport.processGroupId).toBeNull()
    await client.close()
    await expectDead(pid)
    expect(processAlive(grandchild!)).toBe(true)
    process.kill(grandchild!, 'SIGKILL')
    await expectDead(grandchild)
  })

  it('createStdioTransport uses the group transport on POSIX', () => {
    expect(createStdioTransport({ command: process.execPath, args: [], env: {} })).toBeInstanceOf(ChildProcessMcpTransport)
  })

  it('the MCP manager: disabling a user stdio server and the manager\'s stop kill the server and its grandchild', async () => {
    const dir = await tempFolder()
    app = await createMcpTestApp()
    const h = app

    const first = join(dir, 'first')
    await h.t.deps.mcp.create({ id: 'grand', name: 'Grand', transport: mcpMinStdio(['--grandchild', '--pid-file', first]) })
    await waitFor(async () => (await h.t.deps.mcp.get('grand')).status === 'connected')
    const disabledPids = await readMcpPids(first)
    strays.push(disabledPids.pid, disabledPids.grandchild!)
    await h.t.deps.mcp.update('grand', { enabled: false })
    await expectDead(disabledPids.pid, disabledPids.grandchild)

    const second = join(dir, 'second')
    await h.t.deps.mcp.update('grand', { enabled: true, transport: mcpMinStdio(['--grandchild', '--pid-file', second]) })
    await waitFor(async () => (await h.t.deps.mcp.get('grand')).status === 'connected')
    const stopPids = await readMcpPids(second)
    strays.push(stopPids.pid, stopPids.grandchild!)
    expect(processAlive(stopPids.grandchild!)).toBe(true)
    await h.t.deps.mcp.stop()
    await expectDead(stopPids.pid, stopPids.grandchild)
  }, 30_000)
})
