// @ts-check
/// <reference path="./harness-forge.d.ts" />
import { randomInt } from 'node:crypto'

const NOTATION = /^(\d{1,3})d(\d{1,4})([+-]\d{1,5})?$/

/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    const { z } = ctx.ai

    ctx.tools.register({
      name: 'roll_dice',
      description: 'Roll dice in standard notation, for example "1d20" or "2d6+3". Returns every roll and the total.',
      inputSchema: z.object({
        notation: z.string().regex(NOTATION).describe('Dice notation: <count>d<sides>[+|-<modifier>], count <= 100'),
      }),
      policy: 'safe', // read-only and harmless: runs without an approval card in "ask" mode
      async execute({ notation }) {
        const parts = notation.match(NOTATION)
        if (!parts)
          throw new Error(`Invalid notation: ${notation}`)
        const count = Number(parts[1])
        const sides = Number(parts[2])
        const modifier = Number(parts[3] ?? 0)
        if (count < 1 || count > 100 || sides < 2)
          throw new Error('Use 1-100 dice with at least 2 sides.')
        const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1))
        const total = rolls.reduce((sum, roll) => sum + roll, 0) + modifier
        ctx.logger.debug('rolled', { notation, total })
        return { notation, rolls, modifier, total }
      },
    })
  },
}
