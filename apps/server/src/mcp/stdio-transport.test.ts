import process from 'node:process'
import { createMCPClient } from '@ai-sdk/mcp'
import { describe, expect, it } from 'vitest'
import { ECHO_SERVER_PATH, outputJson, processAlive, waitFor } from './__fixtures__/harness.ts'
import { ChildProcessMcpTransport, stdioEnvironment } from './stdio-transport.ts'

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
