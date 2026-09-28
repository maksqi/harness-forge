// The builtin template commands of `core-commands`. Every `{{input}}` is replaced with the text after `/name ` (PLUGINS.md
// section 6); each template also works with an empty input where that makes sense.
import type { CommandDefinition } from '@harness-forge/plugin-sdk'

/** A template slash command (`template` set, no `run`). */
export interface TemplateCommand extends CommandDefinition {
  template: string
}

export const BUILTIN_COMMANDS: readonly TemplateCommand[] = [
  {
    name: 'explain',
    description: 'Explain code or a concept step by step',
    template: [
      'Explain the following clearly and step by step. Start with a one-paragraph summary, then walk through the details.',
      'If it is code, describe what each part does, how the parts interact, and anything surprising or error-prone.',
      '',
      '{{input}}',
    ].join('\n'),
  },
  {
    name: 'summarize',
    description: 'Summarize text, or the conversation so far when no text is given',
    template: [
      'Summarize the text below in a few concise bullet points. Keep key facts, numbers, decisions and open questions.',
      'If no text follows, summarize our conversation so far instead.',
      '',
      '{{input}}',
    ].join('\n'),
  },
  {
    name: 'review',
    description: 'Review code for bugs, security issues and readability',
    template: [
      'Review the following code. List concrete problems ordered by severity: bugs, security issues, performance,',
      'then readability and maintainability. For each, give the location, why it matters and a suggested fix.',
      'Do not invent problems; say so if the code looks correct. End with a one-line overall assessment.',
      '',
      '{{input}}',
    ].join('\n'),
  },
  {
    name: 'fix',
    description: 'Find the root cause of a bug or error and fix it',
    template: [
      'Find the root cause of the problem below (code, error message or stack trace) and fix it.',
      'Explain the cause in one or two sentences, then show the corrected code. Mention anything you had to assume.',
      '',
      '{{input}}',
    ].join('\n'),
  },
  {
    name: 'refactor',
    description: 'Refactor code for clarity without changing its behavior',
    template: [
      'Refactor the following code to make it simpler and easier to read without changing its behavior or public API.',
      'Show the refactored code, then briefly list the changes and why each one helps.',
      '',
      '{{input}}',
    ].join('\n'),
  },
  {
    name: 'tests',
    description: 'Write unit tests for code',
    template: [
      'Write thorough unit tests for the following code. Cover normal cases, edge cases and error handling.',
      'Use the test framework that fits the language and the code base unless one is named below.',
      '',
      '{{input}}',
    ].join('\n'),
  },
  {
    name: 'docs',
    description: 'Write documentation comments for code',
    template: [
      'Write concise documentation for the following code in the idiomatic doc-comment format of its language',
      '(for example JSDoc, docstrings or rustdoc): purpose, parameters, return values, errors and one short example',
      'where it helps. Return the code with the comments added.',
      '',
      '{{input}}',
    ].join('\n'),
  },
  {
    name: 'commit',
    description: 'Write a commit message for a diff',
    template: [
      'Write a Conventional Commits message for the following diff: a subject line of at most 72 characters,',
      'a blank line, then a short body that explains what changed and why. Reply with the message only.',
      '',
      '{{input}}',
    ].join('\n'),
  },
  {
    name: 'translate',
    description: 'Translate text into English, or into the language named first',
    template: [
      'Translate the text below. If it starts with a target language (for example "to German:"), translate into that',
      'language; otherwise translate into English. Keep the meaning, tone and formatting. Reply with the translation only.',
      '',
      '{{input}}',
    ].join('\n'),
  },
  {
    name: 'proofread',
    description: 'Fix grammar, spelling and style of a text',
    template: [
      'Proofread the text below: fix grammar, spelling and punctuation, and improve clarity while keeping the meaning,',
      'tone and formatting. Reply with the corrected text, then list the most important changes.',
      '',
      '{{input}}',
    ].join('\n'),
  },
]
