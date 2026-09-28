// Path parameter and multipart form schemas (API.md section 4.15).
import { z } from 'zod'
import {
  chatIdSchema,
  fileIdSchema,
  iconSlugSchema,
  mcpServerIdSchema,
  pluginIdSchema,
  providerIdSchema,
  shareIdSchema,
  shareTokenSchema,
  toolNameSchema,
} from '../ids.ts'
import { isSafeRelativePath } from '../util/paths.ts'

export const providerParamsSchema = z.object({ id: providerIdSchema })
export type ProviderParams = z.infer<typeof providerParamsSchema>

export const chatParamsSchema = z.object({ id: chatIdSchema })
export type ChatParams = z.infer<typeof chatParamsSchema>

export const fileParamsSchema = z.object({ id: fileIdSchema })
export type FileParams = z.infer<typeof fileParamsSchema>

export const toolParamsSchema = z.object({ name: toolNameSchema })
export type ToolParams = z.infer<typeof toolParamsSchema>

export const mcpServerParamsSchema = z.object({ id: mcpServerIdSchema })
export type McpServerParams = z.infer<typeof mcpServerParamsSchema>

export const pluginParamsSchema = z.object({ id: pluginIdSchema })
export type PluginParams = z.infer<typeof pluginParamsSchema>

export const iconParamsSchema = z.object({ slug: iconSlugSchema })
export type IconParams = z.infer<typeof iconParamsSchema>

/** Owner routes `/shares/:id`. */
export const shareParamsSchema = z.object({ id: shareIdSchema })
export type ShareParams = z.infer<typeof shareParamsSchema>

/**
 * Public route `/share/:token`. The server answers every failure of the public share routes (a malformed token
 * included) with the same `404`, so it checks these params itself instead of answering `400` (API.md 5.20).
 */
export const sharePublicParamsSchema = z.object({ token: shareTokenSchema })
export type SharePublicParams = z.infer<typeof sharePublicParamsSchema>

/** Public route `/share/:token/files/:fileId` (same `404` rule as `sharePublicParamsSchema`). */
export const shareFileParamsSchema = z.object({ token: shareTokenSchema, fileId: fileIdSchema })
export type ShareFileParams = z.infer<typeof shareFileParamsSchema>

/**
 * A file inside a plugin directory (API.md section 5.18): relative POSIX path, 1..256 characters, at most 8 segments of
 * `[A-Za-z0-9._-]`, no leading `/`, no `.` / `..` segments, no backslashes, no NUL.
 */
export const pluginFilePathSchema = z
  .string()
  .refine(isSafeRelativePath, 'Use a relative path of up to 8 segments of A-Z, a-z, 0-9, ".", "_" and "-", without "." or ".." segments.')

/** Params of `/plugins/:id/files/*`: the rest path is bound to `path`. */
export const pluginFileParamsSchema = z.object({ id: pluginIdSchema, path: pluginFilePathSchema })
export type PluginFileParams = z.infer<typeof pluginFileParamsSchema>

/** Multipart fields of `POST /files` and `POST /plugins/inspect`: only the file part `file` (not part of this schema). */
export const fileUploadFormSchema = z.object({})
export type FileUploadForm = z.infer<typeof fileUploadFormSchema>
