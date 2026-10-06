// Test fixture (Phase 11, C38-T3; FROZEN after Gate P11-0b): the grandchild of a stdio MCP server (`mcp-min.mjs
// --grandchild`). A long-lived process without stdio that stays in its parent's process group, so only a group kill
// stops it when the server goes away. `--ignore-term` ignores SIGTERM (only SIGKILL stops it). A safety timer ends it
// after `--lifetime-ms <ms>` (default 120 s), so a failed test never leaves it running for long.
import process from 'node:process'

const args = process.argv.slice(2)
if (args.includes('--ignore-term'))
  process.on('SIGTERM', () => {})

const index = args.indexOf('--lifetime-ms')
const lifetime = index >= 0 ? Number.parseInt(args[index + 1] ?? '', 10) : Number.NaN
setTimeout(() => process.exit(0), Number.isInteger(lifetime) && lifetime > 0 ? lifetime : 120_000)
setInterval(() => {}, 1000)
