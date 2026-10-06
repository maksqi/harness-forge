/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}`, `${user_config.KEY}` and `${VAR}` references are literal fixture content */
// Builders of the Phase 12 fixtures (ADR-053 … ADR-055; C45-T4, FROZEN after Gate P12-0b; phase doc "Mock and fixture
// contract"): Claude Code plugins, a marketplace and a fake Claude Code home folder, shaped like the real formats
// (`.tmp/p12-designs/claude-formats.md` 1 – 5). Builders return in-memory file trees (POSIX path → content + Unix
// permission mode) that `writeFileTree` writes into a `realpath(mkdtemp())` folder at test time: nothing is committed,
// and `writeFileTree` refuses a folder inside the repository unless it is below `.tmp/` (gate run folders), so no
// `.claude/`, `.claude-plugin/` or `.mcp.json` can land in the checkout by accident. The trees also feed the fake remote
// (`commit(repo, tree)`, `githubZipOf`, `npmPackage`) directly.
//
// Plugins (`claudePluginFiles(name)`):
// - `review-kit`: `.claude-plugin/plugin.json` (`userConfig` `API_URL` (a URL text) and the sensitive `API_TOKEN`, an
//   inline http MCP server `review-api` on `${user_config.API_URL}` with `Authorization: Bearer ${user_config.API_TOKEN}`),
//   `.mcp.json` (the stdio server `review-tools`: `node ${CLAUDE_PLUGIN_ROOT}/servers/mcp-min.mjs`, a copy of the
//   dependency-free `mcp/__fixtures__/mcp-min.mjs`, with `TOKEN` / `API_URL` from the user config),
//   `commands/{review,db/migrate,clean_gone}.md`, `agents/code-reviewer.md` (`model: sonnet`),
//   `skills/pdf/{SKILL.md,reference.md,scripts/fill.sh}` (0755), `output-styles/terse.md`, `hooks/hooks.json` (a
//   PostToolUse `Write|Edit` handler running `${CLAUDE_PLUGIN_ROOT}/hooks/format.sh`, an http handler and an unknown
//   event), `hooks/format.sh` (0755: reads stdin, appends a line to `$CLAUDE_PROJECT_DIR/.review-kit-format`, answers
//   `REVIEW_KIT_FORMAT_CONTEXT` as additional context), `.lsp.json` and `bin/tool` (0755, never run: it would write
//   `.review-kit-bin-ran`);
// - `notes-only`: two commands, no manifest (needs no trust);
// - `single-skill`: a root `SKILL.md` and its `reference.md`, no manifest;
// - `broken`: a `plugin.json` whose component paths leave the root (`../`), invalid JSON in `hooks/hooks.json` and
//   `.mcp.json`, one valid command;
// - `broken-manifest`: a `plugin.json` that is not JSON;
// - `uid-mark`: a UserPromptSubmit hook running `${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh` (0755), which writes `id -u` to
//   `$CLAUDE_PROJECT_DIR/.plugin-uid` (the Docker check: hooks run as the image user, never root).
// The marketplace (`claudeMarketplaceFiles()`): `.claude-plugin/marketplace.json` named `acme-tools` with one entry of
// every source kind (relative, bare under `metadata.pluginRoot`, `github`, a github.com git `url`, `git-subdir`,
// `archive` + `sha256`, `npm`, `npm` with a custom registry, `command`, git on another host), a `strict: false` entry
// with inline components, four invalid entries, and the plugin folders its relative entries point at.
// `registerClaudeMarketplaceRemote(routes)` registers on the fake remote everything the remote entries name.
// The fake home (`fakeClaudeHomeFiles()`, paths relative to the home folder; `HF_CLAUDE_HOME` = `<home>/.claude`):
// `.claude/{agents,commands (nested),skills,output-styles}`, `settings.json` (command and prompt hooks, an http handler,
// an unsupported event, Bash allow rules incl. refused ones, a whole-tool `deny`, an `ask` rule, a non-Bash rule, `env`,
// `outputStyle`, `model`, `statusLine`, `apiKeyHelper`, `enabledPlugins`, `extraKnownMarketplaces`), `CLAUDE.md` with an
// `@path` line, the sibling `.claude.json` (top-level `mcpServers`: stdio + http with `${VAR}` headers; a
// `projects[<path>].mcpServers` entry), and the canaries (`CLAUDE_HOME_CANARIES`): `oauthAccount` and `primaryApiKey`
// in `.claude.json`, `.credentials.json`, `projects/x.jsonl`, `history.jsonl`, `settings.local.json`, plus secret env and
// header values that must stay server-side. Every canary is a unique `HF_CANARY-…` string (a hyphen after `HF_CANARY`,
// so the log redactor's `hf_<token>` rule never masks it and a leak stays visible); hygiene checks search for the prefix.
//
// Light on purpose (Node built-ins, the shared package and ./fake-remote.ts): probes and e2e specs import it directly.
import type { ClaudeHomeFile } from '@harness-forge/shared'
import type { FakeFiles, FakeRemoteRoutes } from './fake-remote.ts'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_JSON_PATH, isClaudeHomeImportPath } from '@harness-forge/shared'
import { fakeFileEntry, githubZipOf } from './fake-remote.ts'

// ---------- trees ----------

/** One file of a fixture tree: text or bytes and its Unix permission bits (0644, or 0755 for scripts). */
export interface FixtureFileEntry {
  readonly content: string | Uint8Array
  readonly mode: number
}

/** A fixture tree: POSIX paths relative to its root. Assignable to `FakeFiles` of the fake remote. */
export type FixtureTree = Readonly<Record<string, FixtureFileEntry>>

const FILE = 0o644
const SCRIPT = 0o755

function file(content: string | Uint8Array, mode = FILE): FixtureFileEntry {
  return { content, mode }
}

function json(value: unknown): FixtureFileEntry {
  return file(`${JSON.stringify(value, null, 2)}\n`)
}

/** Every path of `files` below `folder/`. */
export function inFolder(folder: string, files: FixtureTree): FixtureTree {
  const prefix = folder.replace(/\/+$/, '')
  return Object.fromEntries(Object.entries(files).map(([path, entry]) => [`${prefix}/${path}`, entry]))
}

/** The repository root (this file is `apps/server/src/testing/claude-fixtures.ts`). */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Writes `files` below `root` (folders created, each file with its mode, re-applied with `chmod` past the umask) and
 * returns the absolute paths written. `root` must be absolute and outside the repository (or below its `.tmp/`); file
 * paths must be plain relative POSIX paths.
 */
export async function writeFileTree(root: string, files: FixtureTree | FakeFiles): Promise<string[]> {
  if (!isAbsolute(root))
    throw new TypeError('writeFileTree needs an absolute folder (a realpath(mkdtemp()) folder).')
  const target = resolve(root)
  const repositories = [resolve(REPOSITORY_ROOT), await realpath(REPOSITORY_ROOT).catch(() => resolve(REPOSITORY_ROOT))]
  const targets = [target, await realpath(target).catch(() => target)]
  const below = (folder: (repository: string) => string): boolean => targets.some(path => repositories.some(repository => isInside(folder(repository), path)))
  if (below(repository => repository) && !below(repository => join(repository, '.tmp')))
    throw new TypeError('writeFileTree refuses folders inside the repository (use a realpath(mkdtemp()) folder, or one below .tmp/).')
  const written: string[] = []
  for (const path of Object.keys(files).sort()) {
    if (path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))
      throw new TypeError(`The fixture path ${JSON.stringify(path)} must be a plain relative POSIX path.`)
    const { content, mode } = fakeFileEntry(files[path]!)
    const destination = join(target, ...path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content, { mode })
    await chmod(destination, mode)
    written.push(destination.split(sep).join('/'))
  }
  return written
}

// ---------- Claude Code plugins ----------

export const CLAUDE_PLUGIN_FIXTURE_NAMES = ['review-kit', 'notes-only', 'single-skill', 'broken', 'broken-manifest', 'uid-mark'] as const
export type ClaudePluginFixtureName = (typeof CLAUDE_PLUGIN_FIXTURE_NAMES)[number]

/** `hooks/format.sh` of `review-kit` appends one line per run here (in `$CLAUDE_PROJECT_DIR`). */
export const REVIEW_KIT_FORMAT_MARKER = '.review-kit-format'
/** The additional context `hooks/format.sh` answers (PostToolUse). */
export const REVIEW_KIT_FORMAT_CONTEXT = 'review-kit formatted the file'
/** `bin/tool` of `review-kit` would write this file (in its working folder) if anything ever ran it. */
export const REVIEW_KIT_BIN_MARKER = '.review-kit-bin-ran'
/** The `userConfig` keys of `review-kit`. */
export const REVIEW_KIT_USER_CONFIG = { url: 'API_URL', token: 'API_TOKEN' } as const
/** `scripts/mark.sh` of `uid-mark` writes `id -u` here (in `$CLAUDE_PROJECT_DIR`). */
export const UID_MARK_FILE = '.plugin-uid'

const MCP_MIN_SOURCE = fileURLToPath(new URL('../mcp/__fixtures__/mcp-min.mjs', import.meta.url))

function reviewKitFiles(): FixtureTree {
  return {
    '.claude-plugin/plugin.json': json({
      name: 'review-kit',
      version: '1.2.0',
      description: 'Review commands, a reviewer agent, a PDF skill, a terse style, a format hook and two MCP servers.',
      author: { name: 'Acme Tools', email: 'tools@example.com' },
      homepage: 'https://example.com/review-kit',
      license: 'MIT',
      keywords: ['review', 'testing'],
      userConfig: {
        API_URL: { type: 'string', title: 'API URL', description: 'Base URL of the review API (an MCP endpoint).', default: 'https://review.example.com/mcp', required: true },
        API_TOKEN: { type: 'string', title: 'API token', description: 'Token of the review API.', sensitive: true, required: true },
      },
      mcpServers: {
        'review-api': { type: 'http', url: '${user_config.API_URL}', headers: { Authorization: 'Bearer ${user_config.API_TOKEN}' } },
      },
    }),
    '.mcp.json': json({
      mcpServers: {
        'review-tools': {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/servers/mcp-min.mjs', '--name', 'review-tools'],
          env: { TOKEN: '${user_config.API_TOKEN}', API_URL: '${user_config.API_URL}' },
        },
      },
    }),
    'servers/mcp-min.mjs': file(readFileSync(MCP_MIN_SOURCE, 'utf8')),
    'commands/review.md': file([
      '---',
      'description: Review the changed files',
      'argument-hint: "[focus]"',
      'allowed-tools: Read, Grep, Glob',
      '---',
      '',
      'Review the changed files of this project. Focus on $ARGUMENTS.',
      'Use the checklist in ${CLAUDE_PLUGIN_ROOT}/skills/pdf/reference.md when a PDF is involved.',
      '',
    ].join('\n')),
    'commands/db/migrate.md': file([
      '---',
      'description: Plan a database migration',
      'argument-hint: "<table> <change>"',
      '---',
      '',
      'Plan a migration of the table $0 that does this: $1.',
      '',
    ].join('\n')),
    'commands/clean_gone.md': file([
      '---',
      'description: Clean up local branches whose remote is gone',
      '---',
      '',
      'List the local branches whose upstream is gone and suggest how to delete them.',
      '',
    ].join('\n')),
    'agents/code-reviewer.md': file([
      '---',
      'name: code-reviewer',
      'description: Reviews code for bugs, security problems and missing tests.',
      'tools: Read, Grep, Glob',
      'model: sonnet',
      'color: blue',
      '---',
      '',
      'You are a careful code reviewer. Report problems with file and line, most severe first.',
      '',
    ].join('\n')),
    'skills/pdf/SKILL.md': file([
      '---',
      'name: pdf',
      'description: Fill in PDF forms with the bundled script.',
      'argument-hint: "[form file]"',
      'allowed-tools: Read, Bash(sh:*)',
      '---',
      '',
      '# PDF forms',
      '',
      'Read ${CLAUDE_SKILL_DIR}/reference.md first, then run `sh ${CLAUDE_SKILL_DIR}/scripts/fill.sh $ARGUMENTS`.',
      '',
    ].join('\n')),
    'skills/pdf/reference.md': file('# PDF reference\n\nFields are filled in page order.\n'),
    'skills/pdf/scripts/fill.sh': file('#!/bin/sh\nprintf \'filled %s\\n\' "$1"\n', SCRIPT),
    'output-styles/terse.md': file([
      '---',
      'name: Terse',
      'description: Short answers without preamble.',
      'keep-coding-instructions: true',
      '---',
      '',
      'Answer in as few words as possible. No preamble, no summary.',
      '',
    ].join('\n')),
    'hooks/hooks.json': json({
      description: 'Formats files after edits.',
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh', timeout: 30 },
              { type: 'http', url: 'https://hooks.example.com/review-kit' },
            ],
          },
        ],
        TeammateIdle: [{ hooks: [{ type: 'command', command: 'echo idle' }] }],
      },
    }),
    'hooks/format.sh': file([
      '#!/bin/sh',
      '# review-kit format hook (test fixture): reads the payload, records the run, answers additional context.',
      'cat > /dev/null',
      `printf '%s\\n' 'formatted' >> "\${CLAUDE_PROJECT_DIR:-.}/${REVIEW_KIT_FORMAT_MARKER}"`,
      `printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: REVIEW_KIT_FORMAT_CONTEXT } })}'`,
      '',
    ].join('\n'), SCRIPT),
    '.lsp.json': json({ go: { command: 'gopls', args: ['serve'], extensionToLanguage: { '.go': 'go' } } }),
    'bin/tool': file(`#!/bin/sh\n# Never run by the harness (bin/ is listed as ignored).\nprintf 'ran\\n' > ${REVIEW_KIT_BIN_MARKER}\n`, SCRIPT),
    'README.md': file('# review-kit\n\nA Claude Code plugin used by the harness-forge tests.\n'),
  }
}

function notesOnlyFiles(): FixtureTree {
  return {
    'commands/note.md': file('---\ndescription: Write a note about the current task\n---\n\nWrite a short note about: $ARGUMENTS\n'),
    'commands/summarize.md': file('---\ndescription: Summarize the conversation\n---\n\nSummarize this conversation in five bullet points.\n'),
  }
}

function singleSkillFiles(): FixtureTree {
  return {
    'SKILL.md': file([
      '---',
      'name: single-skill',
      'description: Explains the project glossary.',
      '---',
      '',
      'Use the glossary in ${CLAUDE_SKILL_DIR}/reference.md to explain terms.',
      '',
    ].join('\n')),
    'reference.md': file('# Glossary\n\n- harness: the server that runs the agent.\n'),
  }
}

function brokenFiles(): FixtureTree {
  return {
    '.claude-plugin/plugin.json': json({
      name: 'broken',
      version: '0.0.1',
      commands: '../outside-commands',
      agents: ['./agents/../../escape.md'],
      skills: ['../skills'],
      hooks: '../hooks.json',
    }),
    'hooks/hooks.json': file('{ "hooks": { "PostToolUse": [ \n'),
    '.mcp.json': file('{ "mcpServers": '),
    'commands/ok.md': file('---\ndescription: The one valid command\n---\n\nSay that the plugin is broken.\n'),
  }
}

function brokenManifestFiles(): FixtureTree {
  return {
    '.claude-plugin/plugin.json': file('{ "name": "broken-manifest", '),
    'commands/hello.md': file('---\ndescription: Say hello\n---\n\nSay hello.\n'),
  }
}

function uidMarkFiles(): FixtureTree {
  return {
    '.claude-plugin/plugin.json': json({ name: 'uid-mark', version: '1.0.0', description: 'Writes the user id its hook runs as.' }),
    'hooks/hooks.json': json({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh' }] }] } }),
    'scripts/mark.sh': file(`#!/bin/sh\n# uid-mark hook (test fixture): records the user id the hook runs as.\ncat > /dev/null\nid -u > "\${CLAUDE_PROJECT_DIR:-.}/${UID_MARK_FILE}"\n`, SCRIPT),
  }
}

/** The files of a Claude Code plugin fixture (see the module comment), relative to the plugin root. */
export function claudePluginFiles(name: ClaudePluginFixtureName): FixtureTree {
  switch (name) {
    case 'review-kit':
      return reviewKitFiles()
    case 'notes-only':
      return notesOnlyFiles()
    case 'single-skill':
      return singleSkillFiles()
    case 'broken':
      return brokenFiles()
    case 'broken-manifest':
      return brokenManifestFiles()
    case 'uid-mark':
      return uidMarkFiles()
    default:
      throw new TypeError(`Unknown Claude plugin fixture ${JSON.stringify(name)}.`)
  }
}

// ---------- the marketplace ----------

/** The marketplace's name and the remote sources its entries name (all served by `registerClaudeMarketplaceRemote`). */
export const CLAUDE_MARKETPLACE = {
  name: 'acme-tools',
  /** The GitHub repository that holds the marketplace itself (`owner/repo`, default branch `main`). */
  repo: 'acme/claude-marketplace',
  /** A hosted copy of the `marketplace.json` (a `url` marketplace: its relative entries cannot resolve). */
  jsonUrl: 'https://example.com/acme/marketplace.json',
  /** `github` entry `gh-plugin` (ref `v1`): the `single-skill` files. */
  githubRepo: 'acme/gh-plugin',
  githubRef: 'v1',
  /** `url` entry `url-plugin` on github.com (default branch): the `notes-only` files. */
  urlRepo: 'acme/url-plugin',
  /** `git-subdir` entry `subdir-plugin`: `notes-only` in `plugins/subdir-plugin` of this repository. */
  monorepo: 'acme/monorepo',
  subdirPath: 'plugins/subdir-plugin',
  /** `archive` entry `archive-plugin`: a zip of `single-skill` below the folder `archive-plugin/` (sha256 pinned). */
  archiveUrl: 'https://downloads.example.com/archive-plugin.zip',
  /** `npm` entry `npm-plugin`: the `notes-only` files, version 1.0.0. */
  npmPackage: '@acme/npm-plugin',
  /** `npm` entry with a custom registry (unsupported). */
  npmPrivatePackage: '@acme/private-plugin',
  npmPrivateRegistry: 'https://npm.acme.example',
} as const

/** The valid plugin entries of the marketplace, in file order (`private-plugin`, `command-plugin`, `gitlab-plugin` unsupported). */
export const CLAUDE_MARKETPLACE_ENTRIES = [
  'review-kit',
  'notes-only',
  'bare-notes',
  'gh-plugin',
  'url-plugin',
  'subdir-plugin',
  'archive-plugin',
  'npm-plugin',
  'private-plugin',
  'command-plugin',
  'gitlab-plugin',
  'inline-tools',
] as const

/**
 * The invalid entries after the valid ones: `Bad Name!` and `no-source` are dropped by `parseMarketplaceJson` (warnings),
 * `bad-github` (an invalid repository) and `escape` (`../outside`) are kept as unsupported entries of kind `unknown`.
 */
export const CLAUDE_MARKETPLACE_INVALID_ENTRIES = ['Bad Name!', 'no-source', 'bad-github', 'escape'] as const

/** The archive of the `archive` entry and its sha256 (hex). */
export function claudeMarketplaceArchive(): { readonly url: string, readonly zip: Uint8Array, readonly sha256: string } {
  const zip = githubZipOf('archive-plugin', '0'.repeat(40), claudePluginFiles('single-skill'), { topFolder: 'archive-plugin', comment: null })
  return { url: CLAUDE_MARKETPLACE.archiveUrl, zip, sha256: createHash('sha256').update(zip).digest('hex') }
}

function inlineToolsFiles(): FixtureTree {
  return {
    'commands/hello.md': file('---\ndescription: Say hello from the inline entry\n---\n\nSay hello to $ARGUMENTS.\n'),
    'agents/helper.md': file('---\nname: helper\ndescription: Helps with small tasks.\n---\n\nHelp with the task you are given.\n'),
  }
}

/** The `marketplace.json` text of `claudeMarketplaceFiles()`. */
export function claudeMarketplaceJson(): string {
  const value = {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: CLAUDE_MARKETPLACE.name,
    owner: { name: 'Acme Tools', email: 'tools@example.com' },
    metadata: { description: 'Plugins of the harness-forge tests.', version: '1.0.0', pluginRoot: './plugins' },
    plugins: [
      { name: 'review-kit', source: './plugins/review-kit', description: 'Review commands, an agent, a skill, a style, hooks and MCP servers.', version: '1.2.0', category: 'development', tags: ['review'] },
      { name: 'notes-only', source: './plugins/notes-only', description: 'Two note commands.', version: '0.3.0', category: 'productivity' },
      { name: 'bare-notes', source: 'notes-only', description: 'The notes plugin through metadata.pluginRoot.' },
      { name: 'gh-plugin', source: { source: 'github', repo: CLAUDE_MARKETPLACE.githubRepo, ref: CLAUDE_MARKETPLACE.githubRef }, description: 'A plugin in its own GitHub repository.' },
      { name: 'url-plugin', source: { source: 'url', url: `https://github.com/${CLAUDE_MARKETPLACE.urlRepo}.git` }, description: 'A github.com git URL.' },
      { name: 'subdir-plugin', source: { source: 'git-subdir', url: CLAUDE_MARKETPLACE.monorepo, path: CLAUDE_MARKETPLACE.subdirPath, ref: 'main' }, description: 'A folder of a monorepo.' },
      { name: 'archive-plugin', source: { source: 'archive', url: CLAUDE_MARKETPLACE.archiveUrl, sha256: claudeMarketplaceArchive().sha256 }, description: 'A zip archive with a pinned sha256.' },
      { name: 'npm-plugin', source: { source: 'npm', package: CLAUDE_MARKETPLACE.npmPackage, version: '^1.0.0' }, description: 'An npm package.' },
      { name: 'private-plugin', source: { source: 'npm', package: CLAUDE_MARKETPLACE.npmPrivatePackage, registry: CLAUDE_MARKETPLACE.npmPrivateRegistry }, description: 'An npm package from a custom registry.' },
      { name: 'command-plugin', source: { source: 'command', command: 'make plugin', timeout: 60 }, description: 'Built by a command.' },
      { name: 'gitlab-plugin', source: { source: 'url', url: 'https://gitlab.com/acme/gitlab-plugin.git' }, description: 'Git on another host.' },
      { name: 'inline-tools', source: './plugins/inline-tools', strict: false, description: 'An entry that is the whole manifest.', version: '0.1.0', commands: ['./commands/hello.md'], agents: ['./agents/helper.md'] },
      { name: 'Bad Name!', source: './plugins/notes-only' },
      { name: 'no-source' },
      { name: 'bad-github', source: { source: 'github', repo: 'not a repository' } },
      { name: 'escape', source: '../outside' },
    ],
  }
  return `${JSON.stringify(value, null, 2)}\n`
}

/** A marketplace folder: `.claude-plugin/marketplace.json` and the plugin folders of its relative entries. */
export function claudeMarketplaceFiles(): FixtureTree {
  return {
    '.claude-plugin/marketplace.json': file(claudeMarketplaceJson()),
    'README.md': file('# acme-tools\n\nA Claude Code marketplace used by the harness-forge tests.\n'),
    ...inFolder('plugins/review-kit', claudePluginFiles('review-kit')),
    ...inFolder('plugins/notes-only', claudePluginFiles('notes-only')),
    ...inFolder('plugins/inline-tools', inlineToolsFiles()),
  }
}

/** The commits `registerClaudeMarketplaceRemote` added (40-hex shas). */
export interface ClaudeMarketplaceRemote {
  readonly marketplace: string
  readonly githubPlugin: string
  readonly urlPlugin: string
  readonly monorepo: string
}

/**
 * Registers on the fake remote what the marketplace names: the marketplace repository (`main`), the `github`, `url`
 * and `git-subdir` repositories, the archive, the npm package and the hosted `marketplace.json`.
 */
export function registerClaudeMarketplaceRemote(routes: FakeRemoteRoutes): ClaudeMarketplaceRemote {
  const marketplace = routes.commit(CLAUDE_MARKETPLACE.repo, claudeMarketplaceFiles())
  const githubPlugin = routes.commit(CLAUDE_MARKETPLACE.githubRepo, claudePluginFiles('single-skill'), { refs: ['main', CLAUDE_MARKETPLACE.githubRef] })
  const urlPlugin = routes.commit(CLAUDE_MARKETPLACE.urlRepo, claudePluginFiles('notes-only'))
  const monorepo = routes.commit(CLAUDE_MARKETPLACE.monorepo, { 'README.md': file('# monorepo\n'), ...inFolder(CLAUDE_MARKETPLACE.subdirPath, claudePluginFiles('notes-only')) })
  routes.serve(CLAUDE_MARKETPLACE.archiveUrl, claudeMarketplaceArchive().zip)
  routes.npmPackage(CLAUDE_MARKETPLACE.npmPackage, { '1.0.0': { files: { 'package.json': json({ name: CLAUDE_MARKETPLACE.npmPackage, version: '1.0.0' }), ...claudePluginFiles('notes-only') } } })
  routes.serve(CLAUDE_MARKETPLACE.jsonUrl, claudeMarketplaceJson())
  return { marketplace, githubPlugin, urlPlugin, monorepo }
}

// ---------- the fake home ----------

/** The canary values of the fake home: none may ever reach an answer, a DTO, a log line or an error. */
export const CLAUDE_HOME_CANARIES = {
  /** `.claude.json` `oauthAccount.emailAddress` (dropped before anything reads the object). */
  oauthAccount: 'HF_CANARY-oauth-account',
  /** `.claude.json` `primaryApiKey`. */
  primaryApiKey: 'HF_CANARY-primary-api-key',
  /** `.claude.json` `projects[<path>].history[].display`. */
  projectHistory: 'HF_CANARY-project-history',
  /** `.claude/.credentials.json` (never opened). */
  credentials: 'HF_CANARY-credentials-file',
  /** `.claude/projects/x.jsonl` (never opened). */
  projectTranscript: 'HF_CANARY-project-transcript',
  /** `.claude/history.jsonl` (never opened). */
  history: 'HF_CANARY-history-file',
  /** `.claude/settings.local.json` (never opened). */
  settingsLocal: 'HF_CANARY-settings-local',
  /** `settings.json` `env.REVIEW_API_TOKEN`: server-side only (it resolves `${REVIEW_API_TOKEN}` of `.claude.json`). */
  envValue: 'HF_CANARY-settings-env-value',
  /** The literal `env.TOOLS_TOKEN` of the stdio server in `.claude.json`: server-side only. */
  mcpEnvValue: 'HF_CANARY-mcp-env-value',
  /** Inside the `apiKeyHelper` and `statusLine` commands (unsupported, never quoted). */
  helperCommand: 'HF_CANARY-helper-command',
  /** Not in any file: a test puts it into `process.env.REVIEW_API_TOKEN` to prove `process.env` is never read. */
  processEnv: 'HF_CANARY-process-env',
} as const

/** The prefix every canary value starts with. */
export const CLAUDE_HOME_CANARY_PREFIX = 'HF_CANARY-'

/** The `projects` key of `.claude.json` in the fake home (a per-project server: imported disabled). */
export const FAKE_CLAUDE_PROJECT_PATH = '/home/user/work/app'

/** The fake home: paths relative to the home folder (`.claude/…` and the sibling `.claude.json`). */
export function fakeClaudeHomeFiles(): FixtureTree {
  const canary = CLAUDE_HOME_CANARIES
  const home: Record<string, FixtureFileEntry> = {
    'agents/reviewer.md': file([
      '---',
      'name: reviewer',
      'description: Reviews code for bugs and missing tests.',
      'tools: Read, Grep, Glob',
      'model: sonnet',
      'color: green',
      '---',
      '',
      'Review the code you are given and list problems by severity.',
      '',
    ].join('\n')),
    'agents/planner.md': file([
      '---',
      'description: Plans multi-step work before anyone edits files.',
      'disallowedTools: Bash',
      'maxTurns: 5',
      'skills: pdf',
      '---',
      '',
      'Write a numbered plan. Do not edit files.',
      '',
    ].join('\n')),
    'commands/deploy.md': file([
      '---',
      'description: Deploy the current branch',
      'argument-hint: "[environment]"',
      'allowed-tools: Bash(git status:*), Bash(npm run deploy:*)',
      '---',
      '',
      'Current status: !`git status --short`',
      '',
      'Deploy the current branch to $ARGUMENTS.',
      '',
    ].join('\n')),
    'commands/frontend/component.md': file('---\ndescription: Create a component\n---\n\nCreate a component named $1 with the props $2.\n'),
    'commands/db/migrate/up.md': file('---\ndescription: Apply the next migration\n---\n\nApply the next migration of $ARGUMENTS[0].\n'),
    'commands/clean_gone.md': file('---\ndescription: Clean up branches whose remote is gone\n---\n\nList the local branches whose upstream is gone.\n'),
    'skills/pdf/SKILL.md': file([
      '---',
      'name: pdf',
      'description: Fill in PDF forms.',
      'argument-hint: "[form file]"',
      'allowed-tools: Read',
      '---',
      '',
      'Read ${CLAUDE_SKILL_DIR}/reference.md, then fill in the form $ARGUMENTS.',
      '',
    ].join('\n')),
    'skills/pdf/reference.md': file('# PDF reference\n\nNot on the import allowlist: only SKILL.md is read.\n'),
    'output-styles/terse.md': file('---\nname: Terse\ndescription: Short answers without preamble.\nkeep-coding-instructions: true\n---\n\nAnswer in as few words as possible.\n'),
    'settings.json': json({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      model: 'sonnet',
      outputStyle: 'Terse',
      env: { REVIEW_API_TOKEN: canary.envValue, LOG_LEVEL: 'debug' },
      permissions: {
        allow: ['Bash(npm run test:*)', 'Bash(git status)', 'Bash(git diff:*)', 'Bash(npx:*)', 'Bash(python3:*)', 'Bash(*)', 'Read(./src/**)', 'mcp__github__get_issue'],
        deny: ['WebFetch', 'Bash(curl:*)'],
        ask: ['Bash(git push:*)'],
        defaultMode: 'acceptEdits',
      },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh ~/.claude/hooks/check-bash.sh', timeout: 10 }] }],
        PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'npx prettier --write "$CLAUDE_PROJECT_DIR"', statusMessage: 'Formatting…' }] }],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check that every task of the conversation is complete. $ARGUMENTS', timeout: 30 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'Refuse prompts that ask for credentials.', model: 'haiku' }] }],
        Notification: [{ hooks: [{ type: 'http', url: 'https://hooks.example.com/notify' }] }],
        TeammateIdle: [{ hooks: [{ type: 'command', command: 'echo idle' }] }],
      },
      statusLine: { type: 'command', command: `echo ${canary.helperCommand}` },
      apiKeyHelper: `echo ${canary.helperCommand}`,
      enabledPlugins: { 'review-kit@acme-tools': true },
      extraKnownMarketplaces: { 'acme-tools': { source: { source: 'github', repo: CLAUDE_MARKETPLACE.repo } } },
      includeCoAuthoredBy: false,
    }),
    'CLAUDE.md': file('# Personal instructions\n\n- Prefer small, focused changes.\n- Write a test for every new behavior.\n\n@docs/style-guide.md\n'),
    'settings.local.json': json({ env: { LOCAL_SECRET: canary.settingsLocal } }),
    '.credentials.json': json({ claudeAiOauth: { accessToken: canary.credentials, refreshToken: canary.credentials, expiresAt: 1_900_000_000_000 } }),
    'projects/x.jsonl': file(`${JSON.stringify({ type: 'user', message: { role: 'user', content: canary.projectTranscript } })}\n`),
    'history.jsonl': file(`${JSON.stringify({ display: canary.history, timestamp: 1_700_000_000_000 })}\n`),
  }
  return {
    ...inFolder('.claude', home),
    '.claude.json': json({
      numStartups: 42,
      oauthAccount: { accountUuid: '00000000-0000-4000-8000-000000000000', emailAddress: canary.oauthAccount },
      primaryApiKey: canary.primaryApiKey,
      mcpServers: {
        'local-tools': { type: 'stdio', command: 'node', args: ['/opt/tools/server.mjs', '--stdio'], env: { TOOLS_TOKEN: canary.mcpEnvValue } },
        'docs-api': { type: 'http', url: 'https://docs.example.com/mcp', headers: { 'Authorization': 'Bearer ${REVIEW_API_TOKEN}', 'X-Team': '${TEAM_ID:-core}' } },
      },
      projects: {
        [FAKE_CLAUDE_PROJECT_PATH]: {
          allowedTools: [],
          history: [{ display: canary.projectHistory }],
          mcpServers: { 'app-db': { command: 'npx', args: ['-y', 'db-mcp-server'] } },
        },
      },
    }),
  }
}

/**
 * What a home scan would collect from a fake home tree: the allowlisted files (`isClaudeHomeImportPath`), paths relative
 * to the `.claude` folder, `.claude.json` as `CLAUDE_JSON_PATH`; the input of `planClaudeImport`.
 */
export function claudeHomeImportFiles(tree: FixtureTree = fakeClaudeHomeFiles()): ClaudeHomeFile[] {
  const decoder = new TextDecoder()
  const files: ClaudeHomeFile[] = []
  for (const path of Object.keys(tree).sort()) {
    const relativePath = path === '.claude.json' ? CLAUDE_JSON_PATH : path.startsWith('.claude/') ? path.slice('.claude/'.length) : null
    if (relativePath === null || !isClaudeHomeImportPath(relativePath))
      continue
    const { content } = tree[path]!
    files.push({ path: relativePath, text: typeof content === 'string' ? content : decoder.decode(content) })
  }
  return files
}
