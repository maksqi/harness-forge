// LobeHub icon DTOs (API.md section 4.6).
import { z } from 'zod'
import { iconSlugSchema } from '../ids.ts'

/** `slug` = mono icon; `hasColor` = `${slug}-color` exists. */
export const lobeIconEntrySchema = z.object({
  slug: iconSlugSchema,
  hasColor: z.boolean(),
})
export type LobeIconEntry = z.infer<typeof lobeIconEntrySchema>

/** `version` of `@lobehub/icons-static-svg`, used as the `?v=` cache buster. */
export const lobeIconListSchema = z.object({
  items: z.array(lobeIconEntrySchema),
  version: z.string(),
})
export type LobeIconList = z.infer<typeof lobeIconListSchema>
