// @ts-check
import { randomInt } from 'node:crypto'

const NOTATION = /^(\d{1,3})d(\d{1,4})([+-]\d{1,5})?$/

/** @param {string} notation */
function roll(notation) {
  const parts = notation.match(NOTATION)
  if (!parts)
    throw new Error(`Invalid notation: ${notation}`)
  const count = Number(parts[1])
  const sides = Number(parts[2])
  const modifier = Number(parts[3] ?? 0)
  if (count < 1 || count > 100 || sides < 2)
    throw new Error('Use 1-100 dice with at least 2 sides.')
  const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1))
  return { notation, rolls, modifier, total: rolls.reduce((sum, value) => sum + value, 0) + modifier }
}

/** @type {import('@harness-forge/plugin-sdk').PluginContext | undefined} */
let current

/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  async setup(ctx) {
    current = ctx
    const { z } = ctx.ai
    ctx.tools.register({
      name: 'roll_dice',
      description: 'Roll dice in standard notation, for example "1d20" or "2d6+3".',
      inputSchema: z.object({ notation: z.string().regex(NOTATION) }),
      policy: 'safe',
      async execute({ notation }) {
        return roll(notation)
      },
    })
    ctx.commands.register({
      name: 'roll',
      description: 'Roll dice without asking the model',
      async run({ input }) {
        const result = roll(input || '1d6')
        return { type: 'reply', markdown: `Rolled ${result.notation}: **${result.total}**` }
      },
    })
    ctx.hooks.on('chat.params', (_input, output) => {
      output.instructions = `${output.instructions}\nDice are available.`.trim()
    }, { priority: 5 })
    const loads = /** @type {number | undefined} */ (await ctx.storage.get('loads')) ?? 0
    await ctx.storage.set('loads', loads + 1)
    ctx.logger.info('dice roller ready', { loads: loads + 1 })
  },
  async dispose() {
    const disposals = /** @type {number | undefined} */ (await current?.storage.get('disposals')) ?? 0
    await current?.storage.set('disposals', disposals + 1)
  },
}
