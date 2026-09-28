// System, auth and global settings DTOs (API.md section 4.3).
import { z } from 'zod'
import {
  densitySchema,
  readingFontSchema,
  reasoningEffortSchema,
  sendKeySchema,
  textSizeSchema,
  toolModeSchema,
} from '../enums.ts'
import { modelRefSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'

/** `GET /health` (public). */
export const healthSchema = z.object({
  ok: z.literal(true),
  /** harness-forge version (root package.json). */
  version: z.string(),
  /** Node.js version of the server, e.g. `v22.12.0`. */
  node: z.string(),
  /** Whole seconds since the server started. */
  uptimeSec: z.int().min(0),
  /** `HF_SAFE_MODE=1`: only builtin plugins are loaded. */
  safeMode: z.boolean(),
  /** `PLUGIN_API_VERSION` of `@harness-forge/plugin-sdk`. */
  pluginApiVersion: z.string(),
  /** Key library versions, read from the installed packages at boot. */
  versions: z.object({
    ai: z.string(),
    hono: z.string(),
    /** Version the served SPA was built with, when known. */
    nuxt: z.string().optional(),
  }),
})
export type Health = z.infer<typeof healthSchema>

export const passwordSourceSchema = z.enum(['env', 'settings'])
export type PasswordSource = z.infer<typeof passwordSourceSchema>

export const authStatusSchema = z.object({
  /** A password is configured (env or settings). */
  enabled: z.boolean(),
  /** True when `enabled` is false. */
  authenticated: z.boolean(),
  /** Where the password comes from. */
  source: passwordSourceSchema.nullable(),
  /** Fresh-auth routes are allowed until then; null when disabled or not logged in. */
  freshUntil: timestampSchema.nullable(),
})
export type AuthStatus = z.infer<typeof authStatusSchema>

/** Body of `POST /auth/login`; not trimmed. */
export const loginBodySchema = z.strictObject({
  password: z.string().min(1).max(1024),
})
export type LoginBody = z.infer<typeof loginBodySchema>

/** Body of `PUT /auth/password`; `newPassword: null` removes the password. */
export const passwordUpdateSchema = z.strictObject({
  /** Required when a password is set. */
  currentPassword: z.string().min(1).max(1024).optional(),
  newPassword: z.string().min(8).max(1024).nullable(),
})
export type PasswordUpdate = z.infer<typeof passwordUpdateSchema>

// ---------- global settings ----------

const settingsFields = {
  displayName: z.string().trim().max(64),
  defaultModelRef: modelRefSchema.nullable(),
  /** null -> the provider's `smallModelId`, else the chat model. */
  titleModelRef: modelRefSchema.nullable(),
  /** Global instructions. */
  instructions: z.string().max(LIMITS.instructionsMaxChars),
  sendKey: sendKeySchema,
  defaultToolMode: toolModeSchema,
  defaultReasoningEffort: reasoningEffortSchema,
  maxSteps: z.int().min(1).max(100),
  altShortcuts: z.boolean(),
  showThinking: z.boolean(),
  density: densitySchema,
  readingFont: readingFontSchema,
  textSize: textSizeSchema,
}

/** `GET /settings`: every key always present (defaults applied by `settingsSchema.parse`). */
export const settingsSchema = z.object({
  displayName: settingsFields.displayName.default(''),
  defaultModelRef: settingsFields.defaultModelRef.default(null),
  titleModelRef: settingsFields.titleModelRef.default(null),
  instructions: settingsFields.instructions.default(''),
  sendKey: settingsFields.sendKey.default('enter'),
  defaultToolMode: settingsFields.defaultToolMode.default('ask'),
  defaultReasoningEffort: settingsFields.defaultReasoningEffort.default('auto'),
  maxSteps: settingsFields.maxSteps.default(20),
  altShortcuts: settingsFields.altShortcuts.default(true),
  showThinking: settingsFields.showThinking.default(false),
  density: settingsFields.density.default('comfortable'),
  readingFont: settingsFields.readingFont.default('sans'),
  textSize: settingsFields.textSize.default('md'),
})
export type Settings = z.infer<typeof settingsSchema>

/** Every global settings key. */
export const SETTINGS_KEYS = settingsSchema.keyof().options

/** Default value of every global setting (DECISIONS.md "Global settings keys"). */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze(settingsSchema.parse({}))

/** Body of `PUT /settings`: strict, partial, at least one key; keys not sent are unchanged. */
export const settingsUpdateSchema = z
  .strictObject(settingsFields)
  .partial()
  .refine(value => Object.keys(value).length > 0, 'Send at least one setting.')
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>
