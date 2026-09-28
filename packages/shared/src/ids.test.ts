import { describe, expect, it } from 'vitest'
import { HarnessError } from './errors.ts'
import {
  BUILTIN_PLUGIN_IDS,
  BUILTIN_PROVIDER_IDS,
  chatIdSchema,
  CLIENT_COMMANDS,
  commandNameSchema,
  createChatId,
  createFileId,
  createMessageId,
  createShareId,
  fileIdSchema,
  formatModelRef,
  isPluginNamespacedId,
  isReservedPluginId,
  mcpServerIdSchema,
  mcpToolName,
  messageIdSchema,
  modelIdSchema,
  modelRefSchema,
  parseModelRef,
  pluginIdSchema,
  providerIdSchema,
  safeParseModelRef,
  shareIdSchema,
  shareTokenSchema,
  toolNameSchema,
} from './ids.ts'
import { fnv1a32Hex } from './util/hash.ts'

describe('model refs', () => {
  it('splits on the first colon', () => {
    expect(parseModelRef('ollama:llama3:8b')).toEqual({ providerId: 'ollama', modelId: 'llama3:8b' })
    expect(parseModelRef('openrouter:anthropic/claude-sonnet-5')).toEqual({ providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-5' })
    expect(parseModelRef('mock:echo')).toEqual({ providerId: 'mock', modelId: 'echo' })
  })

  it('rejects refs without a colon or with invalid parts', () => {
    for (const ref of ['gpt-6', ':model', 'provider:', 'Bad:model', 'a b:model', 'openai:line\nbreak', `openai:${'x'.repeat(257)}`]) {
      expect(safeParseModelRef(ref)).toBeNull()
      expect(() => parseModelRef(ref)).toThrow(HarnessError)
      expect(modelRefSchema.safeParse(ref).success).toBe(false)
    }
    try {
      parseModelRef('nocolon')
    }
    catch (error) {
      expect((error as HarnessError).code).toBe('validation_error')
    }
  })

  it('formats refs and validates the parts', () => {
    expect(formatModelRef('ollama', 'llama3:8b')).toBe('ollama:llama3:8b')
    expect(parseModelRef(formatModelRef('together-ai', 'openai/gpt-oss-120b'))).toEqual({ providerId: 'together-ai', modelId: 'openai/gpt-oss-120b' })
    expect(() => formatModelRef('Bad', 'x')).toThrow(HarnessError)
    expect(() => formatModelRef('openai', '')).toThrow(HarnessError)
  })
})

describe('id schemas', () => {
  it('validates plugin ids', () => {
    for (const id of ['a', 'my-plugin', 'x1', 'a'.repeat(40)])
      expect(pluginIdSchema.safeParse(id).success).toBe(true)
    for (const id of ['', 'My-plugin', '-lead', 'trail-', 'a'.repeat(41), 'under_score', 'dot.ted'])
      expect(pluginIdSchema.safeParse(id).success).toBe(false)
  })

  it('validates provider, tool, command, MCP server and model ids', () => {
    expect(providerIdSchema.safeParse('a'.repeat(64)).success).toBe(true)
    expect(providerIdSchema.safeParse('a'.repeat(65)).success).toBe(false)
    expect(toolNameSchema.safeParse('roll_dice').success).toBe(true)
    expect(toolNameSchema.safeParse('mcp__srv__Tool-1').success).toBe(true)
    expect(toolNameSchema.safeParse('bad name').success).toBe(false)
    expect(toolNameSchema.safeParse('x'.repeat(65)).success).toBe(false)
    expect(commandNameSchema.safeParse('tldr').success).toBe(true)
    expect(commandNameSchema.safeParse('1abc').success).toBe(false)
    expect(commandNameSchema.safeParse('a'.repeat(33)).success).toBe(false)
    expect(mcpServerIdSchema.safeParse('a'.repeat(32)).success).toBe(true)
    expect(mcpServerIdSchema.safeParse('a'.repeat(33)).success).toBe(false)
    expect(modelIdSchema.safeParse('anthropic/claude:free').success).toBe(true)
    expect(modelIdSchema.safeParse('tab\there').success).toBe(false)
  })

  it('validates chat, message and file ids', () => {
    expect(chatIdSchema.safeParse('0199a8f0-0000-7000-8000-000000000001').success).toBe(true)
    expect(chatIdSchema.safeParse('0199A8F0-0000-7000-8000-000000000001').success).toBe(false)
    expect(chatIdSchema.safeParse('0199a8f0-0000-4000-8000-000000000001').success).toBe(false)
    expect(messageIdSchema.safeParse('msg_gate000000000001').success).toBe(true)
    expect(messageIdSchema.safeParse('msg-gate000000000001').success).toBe(false)
    expect(fileIdSchema.safeParse('file_ABCdef0123456789').success).toBe(true)
  })

  it('validates share ids and share tokens (ADR-025)', () => {
    expect(shareIdSchema.safeParse('shr_ABCdef0123456789').success).toBe(true)
    for (const id of ['shr_ABCdef012345678', 'shr_ABCdef0123456789x', 'shr-ABCdef0123456789', 'shr_ABCdef012345678_'])
      expect(shareIdSchema.safeParse(id).success, id).toBe(false)
    // The 16-character share id suffix + 22 base64url characters of the HMAC.
    const token = `ABCdef0123456789${'aZ09_-'.repeat(3)}xyzw`
    expect(token).toHaveLength(38)
    expect(shareTokenSchema.safeParse(token).success).toBe(true)
    for (const bad of [token.slice(0, 37), `${token}a`, `_${token.slice(1)}`, `${token.slice(0, 37)}=`, `${token.slice(0, 37)}/`])
      expect(shareTokenSchema.safeParse(bad).success, bad).toBe(false)
  })
})

describe('builtin and reserved ids', () => {
  it('lists the builtin ids of DECISIONS.md', () => {
    expect(BUILTIN_PROVIDER_IDS).toEqual(['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshotai', 'alibaba', 'zai', 'minimax', 'mistral', 'groq', 'openrouter', 'ollama'])
    expect(BUILTIN_PLUGIN_IDS).toEqual(['core-providers', 'core-tools', 'core-commands', 'core-mcp', 'mock'])
    expect(CLIENT_COMMANDS).toEqual(['new', 'model', 'effort', 'mode', 'help'])
  })

  it('reserves core-*, mock and the builtin provider ids', () => {
    for (const id of ['core-providers', 'core-x', 'mock', 'openai', 'ollama', ...BUILTIN_PROVIDER_IDS])
      expect(isReservedPluginId(id)).toBe(true)
    for (const id of ['core', 'my-openai', 'together-ai', 'mocker'])
      expect(isReservedPluginId(id)).toBe(false)
  })

  it('checks the plugin namespace of provider and MCP server ids', () => {
    expect(isPluginNamespacedId('acme', 'acme')).toBe(true)
    expect(isPluginNamespacedId('acme', 'acme-eu')).toBe(true)
    expect(isPluginNamespacedId('acme', 'acme-eu-2')).toBe(true)
    expect(isPluginNamespacedId('acme', 'acmex')).toBe(false)
    expect(isPluginNamespacedId('acme', 'other')).toBe(false)
    expect(isPluginNamespacedId('acme', 'acme-')).toBe(false)
    expect(isPluginNamespacedId('acme', 'acme-EU')).toBe(false)
  })
})

describe('mcpToolName', () => {
  it('prefixes and sanitizes', () => {
    expect(mcpToolName('everything', 'echo')).toBe('mcp__everything__echo')
    expect(mcpToolName('mcp-everything', 'get.weather now')).toBe('mcp__mcp-everything__get_weather_now')
    expect(mcpToolName('srv', 'emoji😀')).toBe('mcp__srv__emoji_')
  })

  it('truncates long names to 64 characters with an FNV-1a suffix', () => {
    const tool = 'a_really_long_tool_name_that_keeps_going_and_going_beyond_the_limit'
    const name = mcpToolName('server', tool)
    const full = `mcp__server__${tool}`
    expect(name).toHaveLength(64)
    expect(name).toBe(`${full.slice(0, 55)}_${fnv1a32Hex(full)}`)
    expect(name).toMatch(/^[\w-]{1,64}$/)
    expect(mcpToolName('server', tool)).toBe(name)
    expect(mcpToolName('server', `${tool}2`)).not.toBe(name)
  })

  it('keeps names of exactly 64 characters', () => {
    const tool = 'x'.repeat(64 - 'mcp__srv__'.length)
    expect(mcpToolName('srv', tool)).toBe(`mcp__srv__${tool}`)
  })

  it('uses the reference FNV-1a 32 vectors', () => {
    expect(fnv1a32Hex('')).toBe('811c9dc5')
    expect(fnv1a32Hex('a')).toBe('e40c292c')
    expect(fnv1a32Hex('foobar')).toBe('bf9cf968')
  })
})

describe('id generators', () => {
  it('creates message ids: msg_ + 16 alphanumeric characters', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => createMessageId()))
    expect(ids.size).toBe(2000)
    for (const id of ids)
      expect(id).toMatch(/^msg_[\dA-Za-z]{16}$/)
  })

  it('creates file ids', () => {
    expect(createFileId()).toMatch(/^file_[\dA-Za-z]{16}$/)
  })

  it('creates share ids whose suffix can start a share token', () => {
    const id = createShareId()
    expect(shareIdSchema.safeParse(id).success).toBe(true)
    expect(shareTokenSchema.safeParse(`${id.slice(4)}${'A'.repeat(22)}`).success).toBe(true)
    expect(createShareId()).not.toBe(id)
  })

  it('creates lowercase uuidv7 chat ids with the current timestamp', () => {
    const before = Date.now()
    const id = createChatId()
    const after = Date.now()
    expect(chatIdSchema.safeParse(id).success).toBe(true)
    const timestamp = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)
    expect(timestamp).toBeGreaterThanOrEqual(before)
    expect(timestamp).toBeLessThanOrEqual(after + 1)
  })

  it('creates strictly increasing chat ids within one process', () => {
    const ids = Array.from({ length: 5000 }, () => createChatId())
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })
})
