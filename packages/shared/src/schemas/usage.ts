// Token usage of a message (API.md section 6.5), in its own module so that `chat.ts` and `schemas/agent.ts` can both
// use it without an import cycle. Re-exported by `chat.ts`.
import { z } from 'zod'

const tokenCountSchema = z.int().min(0)

/** Tokens summed over all steps of a message. */
export const messageUsageSchema = z.object({
  /** AI SDK `usage.inputTokens`. */
  inputTokens: tokenCountSchema.optional(),
  /** `usage.outputTokens` (includes reasoning). */
  outputTokens: tokenCountSchema.optional(),
  /** `usage.outputTokenDetails.reasoningTokens`. */
  reasoningTokens: tokenCountSchema.optional(),
  /** `usage.inputTokenDetails.cacheReadTokens`. */
  cacheReadTokens: tokenCountSchema.optional(),
  /** `usage.inputTokenDetails.cacheWriteTokens`. */
  cacheWriteTokens: tokenCountSchema.optional(),
  totalTokens: tokenCountSchema.optional(),
  /** Input + output tokens of the final step: current context occupancy (context ring). */
  contextTokens: tokenCountSchema.optional(),
})
export type MessageUsage = z.infer<typeof messageUsageSchema>
