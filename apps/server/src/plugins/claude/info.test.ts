/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` is literal plugin content */
// The Claude Code plugin info (W12.1-T10): the `review-kit` info as the inspection and the detail show it, valid for
// `claudePluginInfoSchema`; the never-run parts listed; the diagnostics capped.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudePluginInfoSchema, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { claudePluginFiles, writeFileTree } from '../../testing/claude-fixtures.ts'
import { cappedDiagnostics } from './info.ts'
import { readClaudePluginDirectory } from './reader.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined)
    await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('the Claude Code plugin info', () => {
  it('review-kit: identity, counts, the trust consent, hosts, options, ignored parts', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hf-claude-info-')))
    const dir = join(root, 'review-kit')
    await writeFileTree(dir, claudePluginFiles('review-kit'))
    const info = (await readClaudePluginDirectory(dir)).claude!.info
    expect(claudePluginInfoSchema.parse(info)).toEqual(info)
    expect(info).toMatchObject({
      name: 'review-kit',
      version: '1.2.0',
      namespace: 'review-kit',
      components: { commands: 3, agents: 1, skills: 1, outputStyles: 1, hooks: 1, mcpServers: 2 },
      executables: [
        { kind: 'hook', label: 'PostToolUse Write|Edit', command: '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh' },
        { kind: 'hook', label: 'TeammateIdle *', command: 'echo idle' },
        { kind: 'mcp', label: 'review-tools', command: 'node ${CLAUDE_PLUGIN_ROOT}/servers/mcp-min.mjs --name review-tools' },
      ],
      hosts: ['review.example.com', 'hooks.example.com'],
      userConfig: [
        { key: 'API_URL', title: 'API URL', sensitive: false, required: true },
        { key: 'API_TOKEN', title: 'API token', sensitive: true, required: true },
      ],
      unsupported: [
        { component: '.lsp.json', reason: 'LSP servers are not supported; they are never started.' },
        { component: 'bin/', reason: 'Plugin programs (bin/) are never put on the PATH or run.' },
        { component: 'hooks.PostToolUse (http)', reason: 'HTTP hook handlers are not supported; they never run.' },
      ],
    })
    expect(info).not.toHaveProperty('displayName')
    // No option value and no file content in the info.
    expect(JSON.stringify(info)).not.toContain('Bearer')
    expect(JSON.stringify(info)).not.toContain('careful code reviewer')
  })

  it('caps the diagnostics with a last entry that counts the rest', () => {
    const many = Array.from({ length: LIMITS.claudePluginDiagnosticsMax + 10 }, (_, index) => ({ level: 'warning' as const, code: 'x', message: `problem ${index}` }))
    const capped = cappedDiagnostics(many)
    expect(capped).toHaveLength(LIMITS.claudePluginDiagnosticsMax)
    expect(capped.at(-1)).toEqual({ level: 'info', code: 'too-many', message: '11 more problems were found.' })
  })
})
