/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` and `${user_config.KEY}` are literal plugin content */
// The variable table of Claude Code plugins (W12.1-T3; server-plugins.md D10): markdown bodies (absolute paths,
// non-sensitive options only, spans untouched), exec-form hooks (the plugin folders substituted at load, every
// `${user_config.KEY}` kept for the runner: W12.16), shell-form hooks (refused with `${user_config.*}`), MCP
// declarations (`{{settings.*}}`, the plugin folders literal), the option environment; never `process.env`.
import type { HooksConfig, McpServerDecl } from '@harness-forge/plugin-sdk'
import process from 'node:process'
import { readHooksConfig } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadedMcpDecl, substituteHookConfig, substituteHookWord } from './register.ts'
import { claudeSettingsSchema, optionEnvironment, userConfigValues } from './user-config.ts'
import { pluginVariables, referencesProjectDir, substituteCommandBody, substituteExec, substituteMarkdown, userConfigReferences } from './variables.ts'

const ROOT = '/srv/data/plugins/kit'
const DATA = '/srv/data/plugins/.data/kit'
const OPTIONS = [
  { key: 'FOCUS', type: 'string', title: 'Focus', required: false, multiple: false, sensitive: false, default: 'bugs' },
  { key: 'TOKEN', type: 'string', title: 'Token', required: false, multiple: false, sensitive: true },
  { key: 'LANGS', type: 'string', title: 'Languages', required: false, multiple: true, sensitive: false },
] as const
const CANARY = 'HF_CANARY-env-3d1b'

beforeEach(() => {
  process.env.CLAUDE_PLUGIN_ROOT = CANARY
  process.env.FOCUS = CANARY
})

afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_ROOT
  delete process.env.FOCUS
})

function vars(settings: Record<string, unknown> = { FOCUS: 'bugs', TOKEN: 'sekret', LANGS: ['ts', 'go'] }, skillDir?: string) {
  return pluginVariables({ pluginRoot: ROOT, pluginData: DATA, userConfig: userConfigValues(OPTIONS, settings) }, skillDir)
}

describe('markdown bodies', () => {
  it('get the folders, the skill folder and the non-sensitive options; a sensitive one is empty; never process.env', () => {
    const text = substituteMarkdown('root ${CLAUDE_PLUGIN_ROOT} data ${CLAUDE_PLUGIN_DATA} skill ${CLAUDE_SKILL_DIR} focus ${user_config.FOCUS} langs ${user_config.LANGS} token [${user_config.TOKEN}] project ${CLAUDE_PROJECT_DIR} other ${FOCUS} \\${CLAUDE_PLUGIN_ROOT}', vars(undefined, `${ROOT}/skills/pdf`))
    expect(text).toBe(`root ${ROOT} data ${DATA} skill ${ROOT}/skills/pdf focus bugs langs ts,go token [] project \${CLAUDE_PROJECT_DIR} other \${FOCUS} \${CLAUDE_PLUGIN_ROOT}`)
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain('sekret')
  })

  it('command bodies keep their ! spans and file references byte for byte', () => {
    const body = 'Focus ${user_config.FOCUS} in ${CLAUDE_PLUGIN_ROOT}.\nNow: !`ls "${CLAUDE_PLUGIN_ROOT}" ${user_config.FOCUS}` and @docs/${user_config.FOCUS}.md\n```\n!`not a span ${user_config.FOCUS}`\n```\n'
    expect(substituteCommandBody(body, vars())).toBe(`Focus bugs in ${ROOT}.\nNow: !\`ls "\${CLAUDE_PLUGIN_ROOT}" \${user_config.FOCUS}\` and @docs/\${user_config.FOCUS}.md\n\`\`\`\n!\`not a span bugs\`\n\`\`\`\n`)
    expect(substituteCommandBody('No spans: ${user_config.FOCUS}', vars())).toBe('No spans: bugs')
  })

  it('finds the option references and the project folder', () => {
    expect(userConfigReferences('${user_config.A} ${user_config.B} \\${user_config.C} ${user_config.A}')).toEqual(['A', 'B'])
    expect(referencesProjectDir('cd ${CLAUDE_PROJECT_DIR}')).toBe(true)
    expect(referencesProjectDir('\\${CLAUDE_PROJECT_DIR}')).toBe(false)
  })
})

describe('hooks', () => {
  it('exec-form handlers get the plugin folders at load and keep every option reference; shell-form handlers are left to the environment', () => {
    const config = {
      PostToolUse: [{
        matcher: 'Write',
        hooks: [
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/check', args: ['--data', '${CLAUDE_PLUGIN_DATA}', '--token', '${user_config.TOKEN}', '${CLAUDE_PROJECT_DIR}', '--focus=${user_config.FOCUS}', '${user_config.LANGS}'] },
          { type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hook.sh"' },
        ],
      }],
    } as unknown as HooksConfig
    const loaded = substituteHookConfig(config, vars()) as unknown as { PostToolUse: [{ hooks: [{ command: string, args: string[] }, { command: string }] }] }
    // W12.16: no option value (sensitive or not) is part of the registered handler; the runner substitutes at spawn.
    expect(loaded.PostToolUse[0].hooks[0]).toMatchObject({ command: `${ROOT}/bin/check`, args: ['--data', DATA, '--token', '${user_config.TOKEN}', '${CLAUDE_PROJECT_DIR}', '--focus=${user_config.FOCUS}', '${user_config.LANGS}'] })
    expect(loaded.PostToolUse[0].hooks[1]).toEqual({ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hook.sh"' })
    for (const value of [CANARY, 'sekret', 'bugs', 'ts,go'])
      expect(JSON.stringify(loaded)).not.toContain(value)
  })

  it('substituteHookWord: the folders as substituteExec does; option references, escaped ones and odd shapes byte for byte', () => {
    const cases: Array<[string, string]> = [
      ['${CLAUDE_PLUGIN_ROOT}/x ${user_config.TOKEN}', `${ROOT}/x \${user_config.TOKEN}`],
      ['${user_config.TOKEN}${CLAUDE_PLUGIN_DATA}', `\${user_config.TOKEN}${DATA}`],
      ['\\${user_config.TOKEN} \\${CLAUDE_PLUGIN_ROOT}', '\\${user_config.TOKEN} ${CLAUDE_PLUGIN_ROOT}'],
      ['\\\\${user_config.FOCUS}', '\\\\${user_config.FOCUS}'],
      ['${USER_CONFIG.FOCUS} ${user_config.UNKNOWN} ${user_config.}', '${USER_CONFIG.FOCUS} ${user_config.UNKNOWN} ${user_config.}'],
      ['${FOO:-${user_config.TOKEN}} ${CLAUDE_PROJECT_DIR} ${HOME}', '${FOO:-${user_config.TOKEN}} ${CLAUDE_PROJECT_DIR} ${HOME}'],
      ['plain', 'plain'],
    ]
    for (const [word, expected] of cases)
      expect(substituteHookWord(word, vars())).toBe(expected)
    // Without option references the word is exactly what substituteExec gives.
    for (const word of ['${CLAUDE_PLUGIN_ROOT}/a \\${CLAUDE_PLUGIN_DATA} ${CLAUDE_SKILL_DIR} $HOME', ''])
      expect(substituteHookWord(word, vars())).toBe(substituteExec(word, vars()))
  })

  it('a shell-form handler using ${user_config.*} is refused by the reader (skipped, an error diagnostic)', () => {
    const read = readHooksConfig({ Stop: [{ hooks: [{ type: 'command', command: 'echo ${user_config.TOKEN}' }] }] }, { source: 'plugin', prompts: true })
    expect(read.items).toEqual([])
    expect(read.diagnostics).toEqual([expect.objectContaining({ level: 'error', code: 'invalid-command' })])
  })

  it('the option environment holds every option with a value (secrets too) as CLAUDE_PLUGIN_OPTION_<KEY>', () => {
    expect(optionEnvironment(userConfigValues(OPTIONS, { FOCUS: 'bugs', TOKEN: 'sekret', LANGS: ['ts', 'go'] }))).toEqual({
      CLAUDE_PLUGIN_OPTION_FOCUS: 'bugs',
      CLAUDE_PLUGIN_OPTION_TOKEN: 'sekret',
      CLAUDE_PLUGIN_OPTION_LANGS: 'ts,go',
    })
    expect(optionEnvironment(userConfigValues(OPTIONS, {}))).toEqual({})
  })
})

describe('mCP declarations', () => {
  const stdio: McpServerDecl = {
    id: 'kit',
    name: 'tools',
    transport: { type: 'stdio', command: '${CLAUDE_PLUGIN_ROOT}/server', args: ['--data', '${CLAUDE_PLUGIN_DATA}', '{{settings.TOKEN}}'], env: { HOME_DIR: '${CLAUDE_PLUGIN_DATA}/home' } },
  }

  it('get the folders literally and keep the settings placeholders', () => {
    expect(loadedMcpDecl(stdio, vars())?.transport).toEqual({ type: 'stdio', command: `${ROOT}/server`, args: ['--data', DATA, '{{settings.TOKEN}}'], env: { HOME_DIR: `${DATA}/home` } })
  })

  it('a URL that is only a placeholder gets the non-sensitive value; a secret never; no value: skipped', () => {
    const http = (url: string): McpServerDecl => ({ id: 'kit', name: 'api', transport: { type: 'http', url, headers: { Authorization: 'Bearer {{settings.TOKEN}}' } } })
    expect(loadedMcpDecl(http('{{settings.FOCUS}}'), vars({ FOCUS: 'https://api.example.com/mcp' }))?.transport).toEqual({ type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer {{settings.TOKEN}}' } })
    expect(loadedMcpDecl(http('https://api.example.com/{{settings.TOKEN}}'), vars())?.transport).toMatchObject({ url: 'https://api.example.com/{{settings.TOKEN}}' })
    expect(loadedMcpDecl(http('{{settings.TOKEN}}'), vars())).toBeNull()
    expect(loadedMcpDecl(http('{{settings.FOCUS}}'), vars({}))).toBeNull()
  })
})

describe('userConfig settings', () => {
  it('maps the options and adds a setting per other MCP variable (secret, or text with its default)', () => {
    const result = claudeSettingsSchema(OPTIONS, [{ name: 'API_KEY', defaultValue: null }, { name: 'REGION', defaultValue: 'eu' }])
    expect(result.schema?.properties).toEqual({
      FOCUS: { type: 'string', title: 'Focus', default: 'bugs' },
      TOKEN: { type: 'string', title: 'Token', format: 'secret' },
      LANGS: { type: 'array', title: 'Languages', items: { type: 'string' } },
      env_API_KEY: { type: 'string', title: 'Variable API_KEY', description: 'The value of ${API_KEY} in the plugin\'s MCP servers.', format: 'secret' },
      env_REGION: { type: 'string', title: 'Variable REGION', description: 'The value of ${REGION} in the plugin\'s MCP servers.', default: 'eu' },
    })
    expect(claudeSettingsSchema([], [])).toEqual({ schema: null, diagnostics: [] })
  })
})
