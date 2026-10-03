import { describe, expect, it } from 'vitest'
import { baseNameOf, isHiddenWorkspacePath, isSecretLookingName, isSecretLookingPath } from './sensitive.ts'

describe('secret-looking paths', () => {
  it.each([
    ['.env', true],
    ['.ENV', true],
    ['.env.local', true],
    ['.env.production', true],
    ['.env.example', false],
    ['.env.sample', false],
    ['.env.template', false],
    ['.Env.Example', false],
    ['server.pem', true],
    ['tls/SERVER.PEM', true],
    ['private.key', true],
    ['id_rsa', true],
    ['id_rsa.pub', true],
    ['id_ed25519', true],
    ['id_ed25519_work', true],
    ['.npmrc', true],
    ['.pypirc', true],
    ['.netrc', true],
    ['cert.p12', true],
    ['cert.pfx', true],
    ['credentials.json', true],
    ['credentials-prod.json', true],
    ['secrets.yaml', true],
    ['config/secrets.json', true],
    ['README.md', false],
    ['env.ts', false],
    ['.environment', false],
    ['keys.ts', false],
    ['monkey.ts', false],
    ['credentials.yaml', false],
    ['my-secrets.txt', false],
    ['secrets', false],
    ['src/keyboard.key.ts', false],
    ['.', false],
  ])('%s -> %s', (path, expected) => {
    expect(isSecretLookingPath(path)).toBe(expected)
  })

  it('looks at the file name only', () => {
    expect(isSecretLookingPath('.env/lib/site.py')).toBe(false)
    expect(isSecretLookingPath('deploy/.env')).toBe(true)
    expect(isSecretLookingName('id_rsa')).toBe(true)
    expect(baseNameOf('a/b/c.txt')).toBe('c.txt')
    expect(baseNameOf('.')).toBe('')
  })
})

describe('hidden paths', () => {
  it.each([
    ['.git/hooks/pre-commit', true],
    ['.github/workflows/ci.yml', true],
    ['.husky/pre-push', true],
    ['.vscode/tasks.json', true],
    ['src/.eslintrc', true],
    ['.gitignore', true],
    ['.', false],
    ['./src/a.ts', false],
    ['src/a.ts', false],
    ['docs/v1.2/notes.md', false],
    ['../outside', false],
  ])('%s -> %s', (path, expected) => {
    expect(isHiddenWorkspacePath(path)).toBe(expected)
  })
})
