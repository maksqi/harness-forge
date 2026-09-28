// Uploaded file DTO (API.md section 4.8).
import { z } from 'zod'
import { fileIdSchema } from '../ids.ts'

export const fileRefSchema = z.object({
  id: fileIdSchema,
  /** Sanitized original file name. */
  name: z.string(),
  /** Validated MIME type. */
  mime: z.string(),
  /** Bytes. */
  size: z.int().min(0),
  /** `/api/files/<id>` (the `url` of UI `file` parts). */
  url: z.string(),
})
export type FileRef = z.infer<typeof fileRefSchema>
