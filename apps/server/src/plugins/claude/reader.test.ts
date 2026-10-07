/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` and `${user_config.KEY}` are literal plugin content */
// The Claude Code plugin reader (W12.1-T1): the C45 fixtures `review-kit`, `notes-only`, `single-skill`, `broken` and
// `broken-manifest` read into counts, names and diagnostics; `../` paths and linked files refused; the layout rules of
// `plugin.json` (replace / add / merge) and the marketplace entry overlay.
import type { FixtureTree } from '../../testing/claude-fixtures.ts'
import type { ClaudePluginDirectoryRead } from './types.ts'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pluginManifestBaseSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { claudePluginFiles, writeFileTree } from '../../testing/claude-fixtures.ts'
import { manifestVersionOf, readClaudePluginDirectory, slugSegment } from './reader.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

async function tempRoot(name = 'plugin'): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'hf-claude-reader-')))
  roots.push(parent)
  return join(parent, name)
}

async function folder(files: FixtureTree, name = 'plugin'): Promise<string> {
  const root = await tempRoot(name)
  await writeFileTree(root, files)
  return root
}

function file(content: string, mode = 0o644): { content: string, mode: number } {
  return { content, mode }
}

function codes(read: ClaudePluginDirectoryRead): string[] {
  return (read.claude?.diagnostics ?? []).map(item => item.code)
}

describe('readClaudePluginDirectory: the review-kit fixture', () => {
  it('reads the manifest, names every entry under the plugin id and synthesizes a valid DTO manifest', async () => {
    const root = await folder(claudePluginFiles('review-kit'), 'review-kit')
    const read = await readClaudePluginDirectory(root, { expectedId: 'review-kit' })
    expect(read.directory.problem).toBeNull()
    expect(read.directory.dir).toBe(root)
    const claude = read.claude!
    expect({ id: claude.id, name: claude.name, version: claude.version }).toEqual({ id: 'review-kit', name: 'review-kit', version: '1.2.0' })
    expect(claude.commands.map(command => command.name)).toEqual(['review-kit:clean-gone', 'review-kit:db:migrate', 'review-kit:review'])
    expect(claude.commands.find(command => command.name === 'review-kit:review')).toMatchObject({
      path: 'commands/review.md',
      definition: {
        name: 'review-kit:review',
        description: 'Review the changed files',
        syntax: 'markdown',
        argumentHint: '[focus]',
        allowedTools: ['read_file', 'search_files', 'find_files'],
        template: expect.stringContaining('Focus on $ARGUMENTS.'),
      },
      shellCommands: [],
    })
    // Bodies keep their variables: the registration substitutes them.
    expect(claude.commands.find(command => command.name === 'review-kit:review')?.definition.template).toContain('${CLAUDE_PLUGIN_ROOT}/skills/pdf/reference.md')
    expect(claude.agents).toEqual([expect.objectContaining({
      name: 'review-kit:code-reviewer',
      path: 'agents/code-reviewer.md',
      modelAlias: 'sonnet',
      definition: expect.objectContaining({ name: 'review-kit:code-reviewer', model: 'sonnet', color: 'blue', tools: ['read_file', 'search_files', 'find_files'] }),
    })])
    expect(claude.skills).toEqual([expect.objectContaining({
      name: 'review-kit:pdf',
      path: 'skills/pdf/SKILL.md',
      baseDir: 'skills/pdf',
      definition: expect.objectContaining({ name: 'review-kit:pdf', baseDir: 'skills/pdf', argumentHint: '[form file]', description: 'Fill in PDF forms with the bundled script.' }),
    })])
    expect(claude.styles).toEqual([expect.objectContaining({ name: 'review-kit:terse', definition: expect.objectContaining({ keepCodingInstructions: true }) })])

    const manifest = read.directory.manifest!
    expect(pluginManifestBaseSchema.safeParse(manifest).success).toBe(true)
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: 'review-kit',
      name: 'review-kit',
      version: '1.2.0',
      engines: { harness: '^1.6.0' },
      author: 'Acme Tools',
      homepage: 'https://example.com/review-kit',
      settings: { type: 'object', required: ['API_URL', 'API_TOKEN'] },
    })
    expect(manifest).not.toHaveProperty('contributes')
    expect(manifest.settings?.properties.API_TOKEN).toMatchObject({ type: 'string', format: 'secret' })
    expect(manifest.settings?.properties.API_URL).toMatchObject({ type: 'string', default: 'https://review.example.com/mcp' })
  })

  it('reads the hooks: one command handler, two diagnostics (an http handler, an unknown event)', async () => {
    const root = await folder(claudePluginFiles('review-kit'), 'review-kit')
    const claude = (await readClaudePluginDirectory(root)).claude!
    expect(claude.hooks.commands).toEqual([expect.objectContaining({ event: 'PostToolUse', matcher: 'Write|Edit', command: '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh', timeoutSec: 30 })])
    expect(claude.hooks.prompts).toEqual([])
    expect(claude.hooks.diagnostics.map(item => [item.code, item.level, item.file])).toEqual([
      ['unsupported-type', 'warning', 'hooks/hooks.json'],
      ['unknown-event', 'info', 'hooks/hooks.json'],
    ])
    expect(Object.keys(claude.hooks.config)).toEqual(['PostToolUse', 'TeammateIdle'])
  })

  it('reads the MCP servers of .mcp.json and plugin.json with their ids, Claude names and settings placeholders', async () => {
    const root = await folder(claudePluginFiles('review-kit'), 'review-kit')
    const claude = (await readClaudePluginDirectory(root)).claude!
    expect(claude.mcpServers).toEqual([
      {
        name: 'review-tools',
        id: 'review-kit-review-tools',
        claudeName: 'plugin_review-kit_review-tools',
        decl: {
          id: 'review-kit-review-tools',
          name: 'review-tools',
          transport: {
            type: 'stdio',
            command: 'node',
            args: ['${CLAUDE_PLUGIN_ROOT}/servers/mcp-min.mjs', '--name', 'review-tools'],
            env: { TOKEN: '{{settings.API_TOKEN}}', API_URL: '{{settings.API_URL}}' },
          },
        },
      },
      {
        name: 'review-api',
        id: 'review-kit-review-api',
        claudeName: 'plugin_review-kit_review-api',
        decl: {
          id: 'review-kit-review-api',
          name: 'review-api',
          transport: { type: 'http', url: '{{settings.API_URL}}', headers: { Authorization: 'Bearer {{settings.API_TOKEN}}' } },
        },
      },
    ])
  })

  it('lists exactly what the trust consent shows and requires trust', async () => {
    const root = await folder(claudePluginFiles('review-kit'), 'review-kit')
    const read = await readClaudePluginDirectory(root)
    const claude = read.claude!
    expect(claude.executables).toEqual([
      { kind: 'hook', label: 'PostToolUse Write|Edit', command: '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh' },
      { kind: 'hook', label: 'TeammateIdle *', command: 'echo idle' },
      { kind: 'mcp', label: 'review-tools', command: 'node ${CLAUDE_PLUGIN_ROOT}/servers/mcp-min.mjs --name review-tools' },
    ])
    expect(claude.requiresTrust).toBe(true)
    expect(read.directory.requiresTrust).toBe(true)
    expect(read.directory.hash).toMatch(/^[\da-f]{64}$/)
    expect(claude.treeHash).toBe(read.directory.hash)
  })

  it('reports the renamed command file and the ignored parts as diagnostics; the skill keeps its allowed-tools', async () => {
    const root = await folder(claudePluginFiles('review-kit'), 'review-kit')
    const claude = (await readClaudePluginDirectory(root)).claude!
    expect(claude.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'info', code: 'renamed', path: 'commands/clean_gone.md', message: 'commands/clean_gone.md is named review-kit:clean-gone.' }),
      expect.objectContaining({ level: 'info', code: 'unsupported-component', component: '.lsp.json' }),
      expect.objectContaining({ level: 'info', code: 'unsupported-component', component: 'bin/' }),
    ]))
    expect(claude.skills[0]?.definition.allowedTools).toEqual(['read_file', 'shell'])
    expect(claude.diagnostics.some(item => item.level === 'error')).toBe(false)
    expect(claude.info.unsupported.map(part => part.component)).toEqual(['.lsp.json', 'bin/', 'hooks.PostToolUse (http)'])
  })
})

describe('readClaudePluginDirectory: the other fixtures', () => {
  it('notes-only: no manifest, named after the folder, two commands, no trust', async () => {
    const root = await folder(claudePluginFiles('notes-only'), 'notes-only')
    const read = await readClaudePluginDirectory(root, { nameHint: 'notes-only' })
    const claude = read.claude!
    expect(read.directory.problem).toBeNull()
    expect(claude.manifest).toBeNull()
    expect({ id: claude.id, version: claude.version, info: claude.info.version }).toEqual({ id: 'notes-only', version: '0.0.0', info: null })
    expect(claude.commands.map(command => command.name)).toEqual(['notes-only:note', 'notes-only:summarize'])
    expect(claude.requiresTrust).toBe(false)
    expect(claude.executables).toEqual([])
    expect(read.directory.manifest).toMatchObject({ id: 'notes-only', name: 'notes-only', version: '0.0.0', engines: { harness: '^1.6.0' } })
  })

  it('single-skill: a root SKILL.md is one skill whose folder is the plugin root', async () => {
    const root = await folder(claudePluginFiles('single-skill'), 'single-skill')
    const claude = (await readClaudePluginDirectory(root, { nameHint: 'single-skill' })).claude!
    expect(claude.skills).toEqual([expect.objectContaining({ name: 'single-skill:single-skill', path: 'SKILL.md', baseDir: '.' })])
    expect(claude.skills[0]?.definition.content).toContain('${CLAUDE_SKILL_DIR}/reference.md')
  })

  it('broken: paths leaving the root make the plugin an error; the readable parts are still listed', async () => {
    const root = await folder(claudePluginFiles('broken'), 'broken')
    const read = await readClaudePluginDirectory(root)
    expect(read.directory.problem).toMatchObject({ state: 'error', error: { code: 'plugin_error', details: { pluginId: 'broken', phase: 'load' } } })
    expect(read.directory.problem?.error.message).toMatch(/^\.claude-plugin\/plugin\.json: .*"\.\." is not allowed/)
    const claude = read.claude!
    // Every declared command path was refused, so the default commands/ scan applies.
    expect(claude.commands.map(command => command.name)).toEqual(['broken:ok'])
    expect(claude.agents).toEqual([])
    expect(claude.skills).toEqual([])
    expect(claude.mcpServers).toEqual([])
    expect(claude.hooks.commands).toEqual([])
    expect(codes(read)).toEqual(expect.arrayContaining(['plugin-error', 'path-outside-root', 'invalid-json']))
    expect(claude.diagnostics.filter(item => item.code === 'path-outside-root')).toHaveLength(4)
  })

  it('broken-manifest: an unusable plugin.json is an error; the plugin is named by the hint', async () => {
    const root = await folder(claudePluginFiles('broken-manifest'), 'broken-manifest')
    const read = await readClaudePluginDirectory(root, { nameHint: 'broken-manifest' })
    expect(read.directory.problem?.error.message).toBe('.claude-plugin/plugin.json: plugin.json is not valid JSON.')
    expect(read.claude?.id).toBe('broken-manifest')
    expect(read.claude?.commands.map(command => command.name)).toEqual(['broken-manifest:hello'])
  })

  it('an id that is not the expected folder name is an error', async () => {
    const root = await folder(claudePluginFiles('review-kit'), 'elsewhere')
    const read = await readClaudePluginDirectory(root, { expectedId: 'elsewhere' })
    expect(read.directory.problem?.error.message).toBe('The plugin id "review-kit" (from its name "review-kit") does not match its folder name "elsewhere".')
  })

  it('a missing folder or a file is an error without a Claude Code part', async () => {
    const root = await tempRoot()
    expect(await readClaudePluginDirectory(root)).toMatchObject({ directory: { problem: { error: { message: 'The plugin directory is missing.' } } }, claude: null })
    await writeFile(root, 'x')
    expect(await readClaudePluginDirectory(root)).toMatchObject({ directory: { problem: { error: { message: 'The plugin path is not a directory.' } } }, claude: null })
  })
})

describe('readClaudePluginDirectory: links', () => {
  it.skipIf(process.platform === 'win32')('a symbolic link anywhere in the tree is an error (no hash); a linked folder ignores it', async () => {
    const root = await folder(claudePluginFiles('notes-only'), 'notes-only')
    const outside = await tempRoot('outside.md')
    await writeFile(outside, '---\ndescription: outside\n---\nSecret notes.\n')
    await symlink(outside, join(root, 'commands', 'linked.md'))
    const read = await readClaudePluginDirectory(root, { nameHint: 'notes-only' })
    expect(read.directory.problem?.error.message).toBe('The plugin contains a symbolic link (commands/linked.md); links are not allowed.')
    expect(read.directory.hash).toBeNull()
    // The link is never read or listed; the other files still are.
    expect(read.claude?.commands.map(command => command.name)).toEqual(['notes-only:note', 'notes-only:summarize'])
    expect(read.claude?.diagnostics[0]).toMatchObject({ level: 'error', code: 'plugin-error' })

    const linked = await readClaudePluginDirectory(root, { nameHint: 'notes-only', linked: true })
    expect(linked.directory.problem).toBeNull()
    expect(linked.directory.hash).toMatch(/^[\da-f]{64}$/)
  })
})

describe('readClaudePluginDirectory: plugin.json path rules and the entry overlay', () => {
  const base: FixtureTree = {
    'commands/a.md': file('---\ndescription: A\n---\nA body.\n'),
    'commands/sub/b.md': file('---\ndescription: B\n---\nB body.\n'),
    'extra/c.md': file('---\ndescription: C\n---\nC body.\n'),
    'agents/x.md': file('---\nname: x\ndescription: X\n---\nX.\n'),
    'more-agents/y.md': file('---\nname: y\ndescription: Y\n---\nY.\n'),
    'skills/s1/SKILL.md': file('---\ndescription: S1\n---\nS1.\n'),
    'other-skills/s2/SKILL.md': file('---\ndescription: S2\n---\nS2.\n'),
    'output-styles/plain.md': file('---\ndescription: Plain\n---\nPlain.\n'),
    'styles/fancy.md': file('---\nname: Fancy Style\ndescription: Fancy\n---\nFancy.\n'),
  }

  it('commands, agents and output styles paths replace the scan; skills paths add to it; inline commands are added', async () => {
    const root = await folder({
      ...base,
      '.claude-plugin/plugin.json': file(JSON.stringify({
        name: 'paths',
        commands: ['./extra/c.md', { about: { content: '---\ndescription: About\n---\nAbout this plugin.\n', argumentHint: '[topic]' } }],
        agents: ['./more-agents/y.md'],
        skills: ['./other-skills'],
        outputStyles: './styles',
      })),
    }, 'paths')
    const claude = (await readClaudePluginDirectory(root)).claude!
    expect(claude.commands.map(command => command.name)).toEqual(['paths:c', 'paths:about'])
    expect(claude.commands[1]).toMatchObject({ path: null, definition: { description: 'About', argumentHint: '[topic]' } })
    expect(claude.agents.map(agent => agent.name)).toEqual(['paths:y'])
    expect(claude.skills.map(skill => [skill.name, skill.baseDir])).toEqual([['paths:s1', 'skills/s1'], ['paths:s2', 'other-skills/s2']])
    expect(claude.styles.map(style => style.name)).toEqual(['paths:fancy-style'])
  })

  it('without plugin.json paths: the default scans, subfolders as segments', async () => {
    const root = await folder(base, 'scans')
    const claude = (await readClaudePluginDirectory(root, { nameHint: 'scans' })).claude!
    expect(claude.commands.map(command => command.name)).toEqual(['scans:a', 'scans:sub:b'])
    expect(claude.agents.map(agent => agent.name)).toEqual(['scans:x'])
    expect(claude.skills.map(skill => skill.name)).toEqual(['scans:s1'])
    expect(claude.styles.map(style => style.name)).toEqual(['scans:plain'])
  })

  it('a strict entry appends to the default scan where plugin.json is silent and lets plugin.json win the version', async () => {
    const root = await folder({ ...base, '.claude-plugin/plugin.json': file(JSON.stringify({ name: 'strict', version: '2.0.0' })) }, 'strict')
    const overlay = { name: 'strict', strict: true, version: '9.9.9', overlay: { commands: ['./extra/c.md'] } }
    const read = await readClaudePluginDirectory(root, { overlay })
    expect(read.claude?.version).toBe('2.0.0')
    expect(read.claude?.commands.map(command => command.name)).toEqual(['strict:a', 'strict:sub:b', 'strict:c'])
    const plain = await readClaudePluginDirectory(root)
    expect(plain.directory.hash).not.toBe(read.directory.hash)
  })

  it('a strict: false entry is the manifest of a plugin without plugin.json; with components in plugin.json it is an error', async () => {
    const root = await folder(base, 'entry-only')
    const overlay = { name: 'entry-only', strict: false, version: '1.0.0', description: 'From the entry.', overlay: { agents: ['./more-agents/y.md'] } }
    const read = await readClaudePluginDirectory(root, { overlay })
    expect(read.directory.problem).toBeNull()
    expect(read.claude).toMatchObject({ id: 'entry-only', version: '1.0.0' })
    expect(read.claude?.agents.map(agent => agent.name)).toEqual(['entry-only:y'])
    const conflicting = await folder({ ...base, '.claude-plugin/plugin.json': file(JSON.stringify({ name: 'both', commands: './extra' })) }, 'both')
    const failed = await readClaudePluginDirectory(conflicting, { overlay: { ...overlay, name: 'both' } })
    expect(failed.directory.problem?.error.message).toMatch(/strict": false/)
  })

  it('the version: plugin.json, then the hint, else 0.0.0; the DTO version is semver', async () => {
    const root = await folder(base, 'versions')
    const read = await readClaudePluginDirectory(root, { nameHint: 'versions', versionHint: 'a1b2c3d4e5f6' })
    expect(read.claude?.version).toBe('a1b2c3d4e5f6')
    expect(read.directory.manifest?.version).toBe('0.0.0+a1b2c3d4e5f6')
    expect(manifestVersionOf('1.2.0')).toBe('1.2.0')
    expect(manifestVersionOf('v1.2')).toBe('0.0.0+v1.2')
    expect(manifestVersionOf('2026.10 beta')).toBe('0.0.0+2026.10-beta')
    expect(manifestVersionOf('!!!')).toBe('0.0.0')
  })

  it('a reserved or invalid frontmatter name falls back to the file name; files without a usable name are skipped', async () => {
    const root = await folder({
      'agents/general.md': file('---\nname: general\ndescription: A general agent.\n---\nDo it.\n'),
      'agents/Bad Name.md': file('---\nname: Bad Name\ndescription: Bad.\n---\nBad.\n'),
      'commands/1-setup.md': file('---\ndescription: Setup\n---\nSet up.\n'),
      'commands/compact.md': file('---\ndescription: Not the harness command\n---\nCompact.\n'),
    }, 'names')
    const read = await readClaudePluginDirectory(root, { nameHint: 'names' })
    expect(read.claude?.agents.map(agent => agent.name)).toEqual(['names:bad-name', 'names:general'])
    expect(read.claude?.commands.map(command => command.name)).toEqual(['names:compact'])
    expect(read.claude?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid-name', path: 'commands/1-setup.md' })]))
  })

  it('sensitive options are never inlined into bodies (a warning); unknown options stay literal (an info)', async () => {
    const root = await folder({
      '.claude-plugin/plugin.json': file(JSON.stringify({ name: 'secrets', userConfig: { TOKEN: { type: 'string', title: 'Token', sensitive: true } } })),
      'commands/use.md': file('---\ndescription: Use\n---\nToken ${user_config.TOKEN}, other ${user_config.OTHER}.\n'),
    }, 'secrets')
    const claude = (await readClaudePluginDirectory(root)).claude!
    expect(claude.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warning', code: 'secret-in-body', path: 'commands/use.md' }),
      expect.objectContaining({ level: 'info', code: 'unknown-option', path: 'commands/use.md' }),
    ]))
    expect(claude.info.userConfig).toEqual([{ key: 'TOKEN', title: 'Token', sensitive: true, required: false }])
  })

  it('carries the ADR-058 keys: a fork skill with allowed-tools and a model, a command with named arguments', async () => {
    const root = await folder({
      'skills/audit/SKILL.md': file('---\nname: audit\ndescription: Audits the change.\nwhen_to_use: Before a release.\nallowed-tools: Read, Grep\ndisallowed-tools: Bash\nmodel: haiku\ncontext: fork\nagent: Explore\narguments: [scope]\n---\nAudit $scope.\n'),
      'commands/ship.md': file('---\ndescription: Ship a release\narguments: [version, channel]\ndisallowed-tools: WebFetch\nwhen_to_use: When a release is ready.\ncontext: fork\nagent: general\n---\nShip $version to $channel.\n'),
    }, 'adr58')
    const claude = (await readClaudePluginDirectory(root, { nameHint: 'adr58' })).claude!
    expect(claude.skills[0]?.definition).toEqual({
      name: 'adr58:audit',
      description: 'Audits the change.',
      content: 'Audit $scope.',
      baseDir: 'skills/audit',
      allowedTools: ['read_file', 'search_files'],
      disallowedTools: ['shell'],
      model: 'haiku',
      arguments: ['scope'],
      whenToUse: 'Before a release.',
      context: 'fork',
      agent: 'explore',
    })
    expect(claude.commands[0]?.definition).toMatchObject({
      name: 'adr58:ship',
      arguments: ['version', 'channel'],
      disallowedTools: ['web_fetch'],
      whenToUse: 'When a release is ready.',
      context: 'fork',
      agent: 'general',
    })
  })

  it('! spans of commands are executables (trust required)', async () => {
    const root = await folder({ 'commands/status.md': file('---\ndescription: Status\n---\nStatus: !`git status --short`\n') }, 'spans')
    const read = await readClaudePluginDirectory(root, { nameHint: 'spans' })
    expect(read.claude?.executables).toEqual([{ kind: 'span', label: '/spans:status', command: 'git status --short' }])
    expect(read.directory.requiresTrust).toBe(true)
  })

  it('the mcp__plugin_<name>_<server>__ aliases of agent tools are rewritten to the harness MCP names', async () => {
    const root = await folder({
      '.mcp.json': file(JSON.stringify({ docs: { type: 'http', url: 'https://docs.example.com/mcp' } })),
      'agents/reader.md': file('---\nname: reader\ndescription: Reads docs.\ntools: Read, mcp__plugin_alias-kit_docs__search\n---\nRead.\n'),
    }, 'alias-kit')
    const claude = (await readClaudePluginDirectory(root, { nameHint: 'alias-kit' })).claude!
    expect(claude.mcpServers.map(server => [server.id, server.claudeName])).toEqual([['alias-kit', 'plugin_alias-kit_docs']])
    expect(claude.agents[0]?.definition.tools).toEqual(['read_file', 'mcp__alias-kit__search'])
  })
})

describe('slugSegment', () => {
  it.each([
    ['clean_gone', 'clean-gone'],
    ['Review', 'review'],
    ['a  b', 'a-b'],
    ['-x-', 'x'],
    ['1-setup', null],
    ['', null],
    ['__', null],
  ])('%j -> %j', (raw, slug) => {
    expect(slugSegment(raw)).toBe(slug)
  })
})
