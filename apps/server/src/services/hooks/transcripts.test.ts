// Hook transcripts (W12.5-T3, ADR-057): the Claude Code-compatible lines of a chat's active path (text, `tool_use` /
// `tool_result` with Claude tool names; reasoning, files and `data-*` parts dropped; the caps), written lazily only when a
// hook runs (folder 0700, file 0600, `transcript_path` in the payload), rebuilt when the chat changed, removed with the
// chat and by the orphan sweep.
import type { HarnessUIMessage } from '@harness-forge/shared'
import { Buffer } from 'node:buffer'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { readHookLog, writeHookScript } from '../../testing/hook-scripts.ts'
import { createHookTestKit, hookScope, testSignal, waitFor } from './testing.ts'
import { messageLines, transcriptText } from './transcripts.ts'

const posix = process.platform !== 'win32'
const kit = createHookTestKit()
afterEach(kit.cleanup)

const USER: HarnessUIMessage = { id: 'msg_U000000000000001', role: 'user', metadata: { modelRef: 'mock:echo', startedAt: Date.UTC(2026, 9, 1) }, parts: [{ type: 'text', text: 'Fix the build.' }, { type: 'file', mediaType: 'image/png', url: 'files/aa/x' }] } as HarnessUIMessage
const ASSISTANT = {
  id: 'msg_A000000000000001',
  role: 'assistant',
  metadata: { modelRef: 'mock:echo', startedAt: Date.UTC(2026, 9, 1, 0, 1) },
  parts: [
    { type: 'step-start' },
    { type: 'reasoning', text: 'secret-reasoning-marker' },
    { type: 'text', text: 'Running the build.' },
    { type: 'tool-shell', toolCallId: 'call-1', state: 'output-available', input: { command: 'npm run build' }, output: { exitCode: 0, stdout: 'ok' } },
    { type: 'tool-write_file', toolCallId: 'call-2', state: 'output-error', input: { path: 'a.ts', content: 'x' }, errorText: 'Permission denied.' },
    { type: 'data-hook', data: { id: 'hev_AAAAAAAAAAAAAAAA', event: 'PostToolUse', outcome: 'context', createdAt: 1, hooks: [], context: 'secret-hook-marker' } },
    { type: 'tool-read_file', toolCallId: 'call-3', state: 'output-denied', input: { path: '.env' }, approval: { id: 'apr-1', approved: false, reason: 'no' } },
  ],
} as unknown as HarnessUIMessage

describe('transcript lines', () => {
  it('text, tool_use and tool_result blocks with Claude tool names; reasoning, files and data parts left out', () => {
    const lines = [...messageLines(USER, 0), ...messageLines(ASSISTANT, 0)]
    expect(lines).toEqual([
      { type: 'user', uuid: USER.id, timestamp: '2026-10-01T00:00:00.000Z', role: 'user', content: [{ type: 'text', text: 'Fix the build.' }] },
      {
        type: 'assistant',
        uuid: ASSISTANT.id,
        timestamp: '2026-10-01T00:01:00.000Z',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running the build.' },
          { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'npm run build' } },
          { type: 'tool_use', id: 'call-2', name: 'Write', input: { path: 'a.ts', content: 'x' } },
          { type: 'tool_use', id: 'call-3', name: 'Read', input: { path: '.env' } },
        ],
      },
      {
        type: 'user',
        uuid: `${ASSISTANT.id}:tool-results`,
        timestamp: '2026-10-01T00:01:00.000Z',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: '{"exitCode":0,"stdout":"ok"}' },
          { type: 'tool_result', tool_use_id: 'call-2', content: 'Permission denied.', is_error: true },
          { type: 'tool_result', tool_use_id: 'call-3', content: 'The tool call was denied.', is_error: true },
        ],
      },
    ])
    const text = transcriptText([USER, ASSISTANT], { chatId: 'chat-1', cwd: '/p', version: 'harness-forge/1.8.0', now: 0 })
    const parsed = text.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(parsed.map(line => [line.uuid, line.parentUuid])).toEqual([[USER.id, null], [ASSISTANT.id, USER.id], [`${ASSISTANT.id}:tool-results`, ASSISTANT.id]])
    expect(parsed[0]).toMatchObject({ sessionId: 'chat-1', cwd: '/p', isSidechain: false, userType: 'external', version: 'harness-forge/1.8.0', message: { role: 'user' } })
    expect(text).not.toContain('secret-reasoning-marker')
    expect(text).not.toContain('secret-hook-marker')
    expect(text).not.toContain('files/aa/x')
  })

  it('the caps: a part, a tool result, the whole file (the oldest lines go first)', () => {
    const big = { id: 'msg_B000000000000001', role: 'assistant', parts: [
      { type: 'text', text: 'x'.repeat(LIMITS.transcriptPartBytes + 100) },
      { type: 'tool-shell', toolCallId: 'c', state: 'output-available', input: { command: 'y'.repeat(LIMITS.transcriptPartBytes + 100) }, output: 'z'.repeat(LIMITS.transcriptToolResultBytes * 2) },
    ] } as unknown as HarnessUIMessage
    const [line, results] = messageLines(big, 0)
    const blocks = line!.content as unknown as Array<Record<string, unknown>>
    expect((blocks[0]!.text as string).length).toBe(LIMITS.transcriptPartBytes)
    expect(blocks[1]!.input).toMatchObject({ truncated: true })
    expect(((results!.content[0] as { content: string }).content).length).toBeLessThanOrEqual(LIMITS.transcriptToolResultBytes)

    const messages = Array.from({ length: 10 }, (_, index) => ({ id: `msg_M00000000000000${index}`, role: 'user', parts: [{ type: 'text', text: `${index}`.repeat(200) }] }) as HarnessUIMessage)
    const text = transcriptText(messages, { chatId: 'c', cwd: '/p', version: 'v', now: 0, maxBytes: 2000 })
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2000)
    const kept = text.trimEnd().split('\n').map(entry => JSON.parse(entry) as { uuid: string, parentUuid: string | null })
    expect(kept.at(-1)?.uuid).toBe('msg_M000000000000009')
    expect(kept[0]?.parentUuid).toBeNull()
    expect(kept.length).toBeLessThan(10)
  })
})

describe.skipIf(!posix)('transcripts of the hook service', () => {
  it('written only when a hook runs: transcript_path in the payload, folder 0700, file 0600, valid JSONL; deleted with the chat', async () => {
    const h = await kit.open()
    const chat = await h.t.deps.chats.create({ projectId: h.project.id, messages: [USER, ASSISTANT] })
    const dir = h.t.env.paths.transcripts
    const file = join(dir, `${chat.id}.jsonl`)
    await h.hooks.create({ event: 'PostToolUse', matcher: 'Write', command: await writeHookScript(h.root, 'record') })
    const snapshot = await h.hooks.snapshot(hookScope(h, { chatId: chat.id }))
    // No matching hook: nothing written.
    expect((await snapshot.run('PostToolUse', { tool: { name: 'shell', callId: 'c0', input: {}, output: 'x' } }, { signal: testSignal(), target: 'shell' })).ran).toBe(false)
    await expect(stat(file)).rejects.toThrow()

    await snapshot.run('PostToolUse', { tool: { name: 'write_file', callId: 'c1', input: { path: 'a' }, output: 'ok' } }, { signal: testSignal(), target: 'write_file' })
    const [payload] = await readHookLog(h.root) as Array<{ transcript_path?: string }>
    expect(payload?.transcript_path).toBe(file)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as { type: string, message: { content: Array<{ type: string, name?: string }> } })
    expect(lines.map(line => line.type)).toEqual(['user', 'assistant', 'user'])
    expect(lines[1]!.message.content.filter(block => block.type === 'tool_use').map(block => block.name)).toEqual(['Bash', 'Write', 'Read'])

    await h.t.deps.chats.remove(chat.id)
    await waitFor(async () => stat(file).then(() => false, () => true))
  })

  it('rebuilt when the chat changed; an orphaned transcript is swept at the first use', async () => {
    const h = await kit.open()
    const dir = h.t.env.paths.transcripts
    await mkdir(dir, { recursive: true })
    const orphan = join(dir, '0199a8f0-0000-7000-8000-00000000dead.jsonl')
    await writeFile(orphan, '{}\n')
    const chat = await h.t.deps.chats.create({ projectId: h.project.id, messages: [USER] })
    await h.hooks.create({ event: 'Stop', command: await writeHookScript(h.root, 'record') })
    const run = async (): Promise<string> => {
      await (await h.hooks.snapshot(hookScope(h, { chatId: chat.id }))).run('Stop', { stopHookActive: false }, { signal: testSignal() })
      return readFile(join(dir, `${chat.id}.jsonl`), 'utf8')
    }
    expect((await run()).trimEnd().split('\n')).toHaveLength(1)
    await expect(stat(orphan)).rejects.toThrow()
    await h.t.deps.chats.appendMessage(chat.id, ASSISTANT, USER.id)
    await h.t.deps.chats.setActiveLeaf(chat.id, ASSISTANT.id)
    expect((await run()).trimEnd().split('\n')).toHaveLength(3)
  })

  it('a hook of a chat that does not exist runs without transcript_path', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'Stop', command: await writeHookScript(h.root, 'record') })
    await (await h.hooks.snapshot(hookScope(h))).run('Stop', { stopHookActive: false }, { signal: testSignal() })
    const [payload] = await readHookLog(h.root) as Array<Record<string, unknown>>
    expect(payload).not.toHaveProperty('transcript_path')
  })
})
