// "Command pack" template: slash commands (`ctx.commands.register`): a template command sent to the model and a `run`
// command that answers without a model call. Each command registers on its own, so a name taken by another plugin
// only disables that command (with a log entry).
/* eslint-disable no-template-curly-in-string -- the strings below are lines of generated JavaScript source */
import type { TemplateDefinition } from './definition.ts'
import { commentText, entryHeader, jsString, moduleClose, moduleOpen, sourceFile } from './source.ts'

export const commandPackTemplate: TemplateDefinition = {
  id: 'command-pack',
  label: 'Command pack',
  description: 'Adds slash commands.',
  permissions: [],
  entry: ({ language, name, names }) => sourceFile([
    ...entryHeader({
      language,
      comments: [
        `${commentText(name)}: slash commands for the chat composer.`,
        `Type /${names.commands.summary} or /${names.commands.count} followed by some text in a chat.`,
      ],
      typeImports: ['CommandDefinition'],
    }),
    '',
    ...moduleOpen(language),
    '  setup(ctx) {',
    ...(language === 'ts'
      ? ['    const commands: CommandDefinition[] = [']
      : ['    /** @type {import(\'@harness-forge/plugin-sdk\').CommandDefinition[]} */', '    const commands = [']),
    '      {',
    '        // A template command: {{input}} becomes the text after the command, and the result goes to the model.',
    `        name: ${jsString(names.commands.summary)},`,
    '        description: \'Summarize a text in three short bullet points\',',
    '        template: \'Summarize the following text in three short bullet points:\\n\\n{{input}}\',',
    '      },',
    '      {',
    '        // A run command: { type: \'reply\' } answers without calling the model;',
    '        // { type: \'prompt\', text } sends another text to the model instead.',
    `        name: ${jsString(names.commands.count)},`,
    '        description: \'Count the words of a text without calling the model\',',
    '        async run({ input }) {',
    '          const words = input === \'\' ? 0 : input.split(/\\s+/).length',
    '          return { type: \'reply\', markdown: `**${words}** ${words === 1 ? \'word\' : \'words\'}` }',
    '        },',
    '      },',
    '    ]',
    '',
    '    for (const command of commands) {',
    '      try {',
    '        ctx.commands.register(command)',
    '      }',
    '      catch (error) {',
    '        // Command names are global: when another plugin already uses one, rename it here.',
    '        ctx.logger.warn(`/${command.name} is not available: ${error instanceof Error ? error.message : String(error)}`)',
    '      }',
    '    }',
    '  },',
    moduleClose(language),
  ]),
  readme: ({ names }) => [
    `The plugin adds \`/${names.commands.summary}\` (a template sent to the model) and \`/${names.commands.count}\` (code`,
    'that replies without calling the model). Type `/` in the chat composer to see them. Command names are global:',
    'a name that another plugin already registered is skipped with a warning in the Logs tab.',
  ],
}
