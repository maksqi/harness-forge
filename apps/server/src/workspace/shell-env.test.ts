import { describe, expect, it } from 'vitest'
import { SHELL_DEFAULT_PATH, SHELL_ENV_ALLOWLIST, SHELL_ENV_FIXED, shellEnvironment } from './shell-env.ts'

describe('shellEnvironment', () => {
  it('keeps the allowlisted variables and drops everything else', () => {
    const env = shellEnvironment('/bin/bash', {
      HOME: '/home/u',
      LOGNAME: 'u',
      USER: 'u',
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      TZ: 'UTC',
      TMPDIR: '/tmp/u',
      HF_PASSWORD: 'secret-password',
      HF_MASTER_KEY: 'master',
      HF_DATA_DIR: '/data',
      OPENAI_API_KEY: 'sk-0123456789',
      ANTHROPIC_API_KEY: 'sk-ant-0123456789',
      AWS_SECRET_ACCESS_KEY: 'aws',
      NODE_ENV: 'production',
      NODE_OPTIONS: '--inspect',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    })
    expect(env).toEqual({
      HOME: '/home/u',
      LOGNAME: 'u',
      USER: 'u',
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      TZ: 'UTC',
      TMPDIR: '/tmp/u',
      SHELL: '/bin/bash',
      TERM: 'dumb',
      NO_COLOR: '1',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
    })
  })

  it('overrides SHELL, TERM and the pagers of the server', () => {
    const env = shellEnvironment('/bin/sh', { SHELL: '/bin/zsh', TERM: 'xterm-256color', PAGER: 'less', GIT_PAGER: 'delta', NO_COLOR: '' })
    expect(env).toMatchObject({ SHELL: '/bin/sh', ...SHELL_ENV_FIXED })
  })

  it('skips unset, empty and exported-function values and defaults PATH', () => {
    const env = shellEnvironment('/bin/sh', { HOME: '', USER: '() { evil; }', LANG: undefined })
    expect(env).not.toHaveProperty('HOME')
    expect(env).not.toHaveProperty('USER')
    expect(env).not.toHaveProperty('LANG')
    expect(env.PATH).toBe(SHELL_DEFAULT_PATH)
  })

  it('never lists an HF_ variable, a key or NODE_ENV', () => {
    for (const key of SHELL_ENV_ALLOWLIST)
      expect(key).not.toMatch(/^HF_|KEY|TOKEN|SECRET|NODE_ENV/)
  })
})
