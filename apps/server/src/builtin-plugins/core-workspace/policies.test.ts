import type { TestWorkspace } from './test-helpers.ts'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEditFileTool } from './edit-file.ts'
import { policyPaths, readFilePolicy, writeFilePolicy } from './policies.ts'
import { createReadFileTool } from './read-file.ts'
import { contextWithoutWorkspace, createTestWorkspace } from './test-helpers.ts'
import { createWriteFileTool } from './write-file.ts'

let ws: TestWorkspace

beforeEach(async () => {
  ws = await createTestWorkspace()
})

afterEach(async () => {
  await ws.cleanup()
})

describe('read_file policy', () => {
  it.each([
    ['src/index.ts', 'safe'],
    ['README.md', 'safe'],
    ['.git/config', 'safe'],
    ['.github/workflows/ci.yml', 'safe'],
    ['.env.example', 'safe'],
    ['.env', 'ask'],
    ['config/.env.local', 'ask'],
    ['certs/server.pem', 'ask'],
    ['deploy/id_rsa', 'ask'],
    ['.npmrc', 'ask'],
    ['credentials.json', 'ask'],
    ['secrets.yml', 'ask'],
  ])('%s -> %s', async (path, expected) => {
    expect(await readFilePolicy({ path }, ws.context())).toBe(expected)
    expect(await readFilePolicy({ path }, contextWithoutWorkspace())).toBe(expected)
  })

  it.skipIf(process.platform === 'win32')('asks for a link to a secret-looking file', async () => {
    await ws.write({ '.env': 'KEY=1' })
    await symlink(join(ws.root, '.env'), join(ws.root, 'notes.txt'))
    expect(await readFilePolicy({ path: 'notes.txt' }, ws.context())).toBe('ask')
    // Without the workspace only the spelling is known.
    expect(await readFilePolicy({ path: 'notes.txt' }, contextWithoutWorkspace())).toBe('safe')
  })

  it('judges absolute paths inside the project by their relative spelling', async () => {
    expect(await readFilePolicy({ path: join(ws.root, '.env') }, ws.context())).toBe('ask')
    expect(await readFilePolicy({ path: join(ws.root, 'src', 'a.ts') }, ws.context())).toBe('safe')
  })

  it('is safe for inputs the call will refuse anyway', async () => {
    expect(await readFilePolicy({}, ws.context())).toBe('safe')
    expect(await readFilePolicy(null, ws.context())).toBe('safe')
    expect(await readFilePolicy({ path: 42 }, ws.context())).toBe('safe')
    expect(await readFilePolicy({ path: '../outside/.env' }, ws.context())).toBe('safe')
  })
})

describe('write_file / edit_file policy', () => {
  it.each([
    ['src/index.ts', 'ask'],
    ['notes/todo.md', 'ask'],
    ['.github/workflows/ci.yml', 'always'],
    ['.husky/pre-commit', 'always'],
    ['.vscode/tasks.json', 'always'],
    ['.git/hooks/pre-commit', 'always'],
    ['src/.eslintrc.json', 'always'],
    ['.env', 'always'],
    ['config/secrets.json', 'always'],
    ['keys/deploy.key', 'always'],
    ['./src/a.ts', 'ask'],
  ])('%s -> %s', async (path, expected) => {
    expect(await writeFilePolicy({ path, content: '' }, ws.context())).toBe(expected)
    expect(await writeFilePolicy({ path }, contextWithoutWorkspace())).toBe(expected)
  })

  it.skipIf(process.platform === 'win32')('always asks for a write through a link into a hidden folder', async () => {
    await ws.write({ '.husky/pre-commit': 'echo hi' })
    await symlink(join(ws.root, '.husky', 'pre-commit'), join(ws.root, 'hook.sh'))
    expect(await writeFilePolicy({ path: 'hook.sh' }, ws.context())).toBe('always')
    expect(await policyPaths({ path: 'hook.sh' }, ws.context())).toEqual(['hook.sh', '.husky/pre-commit'])
  })

  it('a missing target is judged by its spelling', async () => {
    expect(await writeFilePolicy({ path: 'new/folder/file.ts' }, ws.context())).toBe('ask')
    expect(await writeFilePolicy({ path: 'new/.config/file.ts' }, ws.context())).toBe('always')
  })

  it('the tools use these functions', () => {
    expect(createReadFileTool().policy).toBe(readFilePolicy)
    expect(createWriteFileTool().policy).toBe(writeFilePolicy)
    expect(createEditFileTool().policy).toBe(writeFilePolicy)
  })
})
