// "MCP bridge" template: connects a remote MCP server (Streamable HTTP) configured in the plugin's settings. The code
// registers the server once a URL is set (`ctx.mcp.register`) and follows settings changes; the token travels as a
// `{{settings.token}}` placeholder, so the secret never appears in the declaration.
/* eslint-disable no-template-curly-in-string -- the strings below are lines of generated JavaScript source */
import type { TemplateDefinition } from './definition.ts'
import { commentText, entryHeader, jsString, moduleClose, moduleOpen, sourceFile, typedLet } from './source.ts'

export const mcpBridgeTemplate: TemplateDefinition = {
  id: 'mcp-bridge',
  label: 'MCP bridge',
  description: 'Connects an MCP server.',
  permissions: ['network'],
  settings: {
    type: 'object',
    properties: {
      serverUrl: {
        type: 'string',
        format: 'url',
        title: 'Server URL',
        description: 'Streamable HTTP endpoint of the MCP server, for example https://mcp.example.com/mcp.',
      },
      token: {
        type: 'string',
        format: 'secret',
        title: 'Access token',
        description: 'Optional. Sent as "Authorization: Bearer <token>".',
      },
    },
  },
  entry: ({ language, name, names }) => sourceFile([
    ...entryHeader({
      language,
      comments: [
        `${commentText(name)}: connects an MCP server. Its tools appear as mcp__${names.mcpServer}__<tool>.`,
        'Set the server URL (and a token if needed) in the Configuration tab: the server connects right away.',
      ],
      typeImports: ['Disposable'],
    }),
    '',
    `const SERVER_ID = ${jsString(names.mcpServer)}`,
    `const SERVER_NAME = ${jsString(name)}`,
    '',
    ...moduleOpen(language),
    '  setup(ctx) {',
    ...typedLet(language, 'server', 'import(\'@harness-forge/plugin-sdk\').Disposable | undefined', 'Disposable | undefined', 'undefined').map(line => `    ${line}`),
    '    let connectedTo = \'\'',
    '',
    ...(language === 'ts'
      ? [
          '    /** Registers the server for the current settings; unchanged settings keep the connection. */',
          '    const connect = (settings: Record<string, unknown>): void => {',
        ]
      : [
          '    /**',
          '     * Registers the server for the current settings; unchanged settings keep the connection.',
          '     * @param {Record<string, unknown>} settings',
          '     */',
          '    const connect = (settings) => {',
        ]),
    '      const url = typeof settings.serverUrl === \'string\' ? settings.serverUrl.trim() : \'\'',
    '      const withToken = typeof settings.token === \'string\' && settings.token !== \'\'',
    '      const target = url === \'\' ? \'\' : `${url} ${withToken ? \'with token\' : \'without token\'}`',
    '      if (target === connectedTo)',
    '        return // Same server: when only the token changed, the host reconnects by itself.',
    '      server?.dispose()',
    '      server = undefined',
    '      connectedTo = target',
    '      if (url === \'\') {',
    '        ctx.logger.info(\'Set the server URL in the Configuration tab to connect.\')',
    '        return',
    '      }',
    '      server = ctx.mcp.register({',
    '        id: SERVER_ID,',
    '        name: SERVER_NAME,',
    '        // Tools without annotations ask before they run; read-only tools (readOnlyHint) run without asking.',
    '        policy: \'ask\',',
    '        transport: {',
    '          type: \'http\',',
    '          url,',
    '          // {{settings.token}} is resolved when connecting, so the secret stays out of the declaration.',
    '          ...(withToken ? { headers: { Authorization: \'Bearer {{settings.token}}\' } } : {}),',
    '        },',
    '      })',
    '      ctx.logger.info(`Connecting to ${url}.`)',
    '    }',
    '',
    '    connect(ctx.settings.get())',
    '    ctx.settings.onChange(connect)',
    '  },',
    moduleClose(language),
  ]),
  readme: ({ names }) => [
    'Open the **Configuration** tab and set the Streamable HTTP URL of your MCP server (and an access token when it',
    `needs one). The server connects and its tools appear as \`mcp__${names.mcpServer}__<tool>\`, with their status in`,
    'the MCP servers panel. To start a local server over stdio instead, register a `stdio` transport',
    '(`{ type: \'stdio\', command, args }`) and declare the `process` permission.',
  ],
}
