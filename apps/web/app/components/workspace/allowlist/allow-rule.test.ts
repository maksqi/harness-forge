// Shell rule copy (docs/UI.md 7.3, 7.23, 11.5): suggestions and notes for the approval card, the prefix check with its
// inline error texts and the one-word warning, and the project of a new rule.
import { describe, expect, it } from 'vitest'
import {
  ALWAYS_ASK_NOTE,
  checkRulePrefix,
  NO_RULE_NOTE,
  ruleErrorMessage,
  ruleProjectId,
  ruleSuggestion,
} from './allow-rule'

describe('ruleSuggestion', () => {
  it('suggests one prefix per part that needs a rule, deduplicated, cd parts left out', () => {
    expect(ruleSuggestion('pnpm test --filter parser')).toEqual({ prefixes: ['pnpm test'], note: null })
    expect(ruleSuggestion('cd web && pnpm build')).toEqual({ prefixes: ['pnpm build'], note: null })
    expect(ruleSuggestion('git status && ls -la && git status')).toEqual({ prefixes: ['git status', 'ls'], note: null })
  })

  it('replaces the option with the always-ask note when the parser refuses the command', () => {
    expect(ruleSuggestion('echo $HOME')).toEqual({ prefixes: [], note: ALWAYS_ASK_NOTE })
    expect(ruleSuggestion('ls > out.txt')).toEqual({ prefixes: [], note: ALWAYS_ASK_NOTE })
    expect(ruleSuggestion('echo `date`')).toEqual({ prefixes: [], note: ALWAYS_ASK_NOTE })
  })

  it('says no rule can allow a command that parses but has no valid prefix', () => {
    expect(ruleSuggestion('sudo rm -rf build')).toEqual({ prefixes: [], note: NO_RULE_NOTE })
  })
})

describe('checkRulePrefix', () => {
  it('canonicalizes a valid prefix and warns about a one-word prefix', () => {
    expect(checkRulePrefix('pnpm   test')).toEqual({ ok: true, canonical: 'pnpm test', warning: null })
    expect(checkRulePrefix('make')).toEqual({ ok: true, canonical: 'make', warning: 'This allows every make command.' })
  })

  it('refuses with the parser reason and the copy of docs/UI.md 7.23', () => {
    expect(checkRulePrefix('   ')).toEqual({ ok: false, code: 'empty', message: 'Enter the start of a command.' })
    expect(checkRulePrefix('x'.repeat(201))).toEqual({ ok: false, code: 'too-long', message: 'Use at most 200 characters.' })
    expect(checkRulePrefix('ls | wc')).toEqual({
      ok: false,
      code: 'syntax',
      message: 'Use a plain command without |, ;, &&, redirections or substitutions.',
    })
    expect(checkRulePrefix('sudo apt')).toEqual({
      ok: false,
      code: 'command-runner',
      message: 'sudo runs other commands, so it can\'t be allowed by a rule.',
    })
    expect(checkRulePrefix('python3')).toEqual({
      ok: false,
      code: 'interpreter',
      message: 'A rule for python3 alone would allow any code. Add what follows it, such as a script name.',
    })
    expect(checkRulePrefix('cd src')).toEqual({
      ok: false,
      code: 'cd',
      message: 'cd needs no rule: changing into a project folder is always allowed.',
    })
    expect(checkRulePrefix('export')).toMatchObject({ ok: false, code: 'shell-builtin', message: expect.stringContaining('export') })
  })

  it('with a command, requires the rule to cover it (the edited prefix of the card)', () => {
    expect(checkRulePrefix('pnpm test', 'pnpm test --run x')).toMatchObject({ ok: true, canonical: 'pnpm test' })
    expect(checkRulePrefix('pnpm', 'cd web && pnpm build')).toMatchObject({ ok: true, canonical: 'pnpm' })
    expect(checkRulePrefix('pnpm lint', 'pnpm test --run x')).toEqual({
      ok: false,
      code: 'no-match',
      message: 'This doesn\'t match the command.',
    })
  })
})

describe('ruleErrorMessage', () => {
  it('names the command word of the prefix', () => {
    expect(ruleErrorMessage('command-runner', '  env FOO=1 ls')).toBe('env runs other commands, so it can\'t be allowed by a rule.')
  })
})

describe('ruleProjectId', () => {
  it('uses the chat\'s project for This project and null for All projects', () => {
    expect(ruleProjectId('project', 'prj_1')).toBe('prj_1')
    expect(ruleProjectId('project', null)).toBeNull()
    expect(ruleProjectId('global', 'prj_1')).toBeNull()
  })
})
