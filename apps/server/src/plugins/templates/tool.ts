// "Tool" template: one tool the model can call (`ctx.tools.register`), with a zod input schema from `ctx.ai.z`, an
// approval policy and a logger call.
import type { TemplateDefinition } from './definition.ts'
import { commentText, entryHeader, jsString, moduleClose, moduleOpen, sourceFile } from './source.ts'

export const toolTemplate: TemplateDefinition = {
  id: 'tool',
  label: 'Tool',
  description: 'Adds a tool the model can call.',
  permissions: [],
  entry: ({ language, name, names }) => sourceFile([
    ...entryHeader({
      language,
      comments: [
        `${commentText(name)}: a tool the model can call.`,
        'Edit the tool, save (Mod+S), then press "Build & reload". Try it in a chat: "Count the words of: ...".',
      ],
    }),
    ...(language === 'ts'
      ? [
          '',
          'interface TextStats {',
          '  characters: number',
          '  words: number',
          '  lines: number',
          '  readingMinutes: number',
          '}',
        ]
      : []),
    '',
    ...moduleOpen(language),
    '  setup(ctx) {',
    '    // Libraries come from the host: ctx.ai.z is zod (code plugins cannot install packages).',
    '    const { z } = ctx.ai',
    '',
    `    ctx.tools.register${language === 'ts' ? '<{ text: string }, TextStats>' : ''}({`,
    '      // Tool names are global: keep the plugin-specific prefix.',
    `      name: ${jsString(names.tool)},`,
    '      description: \'Count the characters, words and lines of a text and estimate its reading time.\',',
    '      inputSchema: z.object({',
    '        text: z.string().max(100_000).describe(\'The text to analyze\'),',
    '      }),',
    '      // \'ask\' shows an approval card before each call (in "ask" mode). Use \'safe\' for read-only tools that may run',
    '      // without asking, or \'always\' for tools that must always ask, even in "auto" mode.',
    '      policy: \'ask\',',
    '      async execute({ text }) {',
    '        const trimmed = text.trim()',
    '        const words = trimmed === \'\' ? 0 : trimmed.split(/\\s+/).length',
    '        const result = {',
    '          characters: [...text].length,',
    '          words,',
    '          lines: text === \'\' ? 0 : text.split(/\\r\\n|\\r|\\n/).length,',
    '          readingMinutes: Math.ceil(words / 230),',
    '        }',
    '        // Log entries appear in the Logs tab of the plugin.',
    '        ctx.logger.debug(\'counted a text\', { words })',
    '        // The result must be JSON-serializable; the model receives it as the tool output.',
    '        return result',
    '      },',
    '    })',
    '  },',
    moduleClose(language),
  ]),
  readme: ({ names }) => [
    `The plugin registers the tool \`${names.tool}\`. Ask for it in a chat with a tool-capable model, for example`,
    '"Count the words of: ...". The tool asks for approval before it runs (policy `ask`); set `policy: \'safe\'` for',
    'tools that only read.',
  ],
}
