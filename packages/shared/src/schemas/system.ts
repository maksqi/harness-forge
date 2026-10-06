// System, auth and global settings DTOs (API.md section 4.3).
import { z } from 'zod'
import {
  densitySchema,
  fileSweepModeSchema,
  readingFontSchema,
  reasoningEffortSchema,
  sendKeySchema,
  textSizeSchema,
  toolModeSchema,
} from '../enums.ts'
import { agentNameSchema, modelRefSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { hasControlChars } from '../util/text.ts'
import { speechVoiceSchema, transcriptionLanguageSchema } from './audio.ts'

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

/** Characters of the `planDirectory` setting. */
export const PLAN_DIRECTORY_MAX_CHARS = 200

/**
 * True for a safe plan folder (setting `planDirectory`, ADR-047): a relative path inside the project, segments separated
 * by `/` (or `\`), no leading separator or drive letter, no empty, `.` or `..` segment, no `.git` segment (any case), no
 * control characters, at most 200 characters.
 */
export function isSafePlanDirectory(value: string): boolean {
  if (value.length === 0 || value.length > PLAN_DIRECTORY_MAX_CHARS || hasControlChars(value))
    return false
  if (/^[/\\]/.test(value) || /^[a-z]:/i.test(value))
    return false
  return value.split(/[/\\]/).every(segment => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git')
}

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
  /** Steps of one agent run in a chat without a project (1..200). */
  maxSteps: z.int().min(1).max(LIMITS.stepsMax),
  altShortcuts: z.boolean(),
  showThinking: z.boolean(),
  density: densitySchema,
  readingFont: readingFontSchema,
  textSize: textSizeSchema,
  // Images and voice (Phase 6): opt-in, no model is chosen automatically.
  /** Image model of the `generate_image` tool (ADR-028); null = the tool is off. */
  imageModelRef: modelRefSchema.nullable(),
  /** Speech-to-text model of dictation (ADR-029); null = dictation is off. */
  transcriptionModelRef: modelRefSchema.nullable(),
  /** Language of dictation: `auto` (detected) or an ISO 639 code. */
  transcriptionLanguage: transcriptionLanguageSchema,
  /** Text-to-speech model of read-aloud (ADR-029); null = read-aloud is off. */
  speechModelRef: modelRefSchema.nullable(),
  /** Voice of read-aloud; null = the provider default (the web clears it when the speech model changes). */
  speechVoice: speechVoiceSchema.nullable(),
  /** Playback speed of read-aloud, 0.5..2 (applied by the browser, never sent to the provider). */
  speechSpeed: z.number().min(0.5).max(2),
  // Agent workspace (Phase 7, ADR-032).
  /** Steps of one agent run in a chat with a project (1..200); `maxSteps` applies to the other chats. */
  projectMaxSteps: z.int().min(1).max(LIMITS.stepsMax),
  // Automatic file sweep (Phase 8, ADR-039).
  /** The automatic orphaned-file cleanup: `off` (manual only), `daily` or `weekly`. */
  fileSweep: fileSweepModeSchema,
  // Agent 2.0 (Phase 9, ADR-040 … ADR-043).
  /** Compact the conversation automatically when the context fills up (ADR-040); off = the oldest turns are trimmed. */
  autoCompact: z.boolean(),
  /** Model that writes compaction summaries; null = the chat model. */
  compactModelRef: modelRefSchema.nullable(),
  /** Model of sub-agents (`task`, ADR-043); null = the chat model. */
  subagentModelRef: modelRefSchema.nullable(),
  /** Steps of one sub-agent (1..200). */
  subagentMaxSteps: z.int().min(1).max(LIMITS.stepsMax),
  /** Shift+Tab in the composer cycles the permission mode (ADR-041); off = Shift+Tab moves the focus. */
  shiftTabModes: z.boolean(),
  // Agent customization (Phase 10, ADR-047).
  /** Save every approved plan of a project chat as a file in the project (`planDirectory`). */
  planFiles: z.boolean(),
  /** The project-relative folder of plan files (`isSafePlanDirectory`). */
  planDirectory: z
    .string()
    .trim()
    .min(1)
    .max(PLAN_DIRECTORY_MAX_CHARS)
    .refine(isSafePlanDirectory, 'Use a folder inside the project, such as ".harness/plans" (no leading "/", no "..", no ".git").'),
  // Hooks and output styles (Phase 11, ADR-048 / ADR-051); neither needs fresh auth.
  /**
   * The global output style (a style name of the catalog; builtins `default`, `explanatory`, `learning`); a project's
   * and a chat's own choice win over it. An unknown name is not refused: runs use `default` with a notice.
   */
  outputStyle: agentNameSchema,
  /** Run command hooks (personal, project and plugin); off = no command hook runs (plugin code hooks still run). */
  hooksEnabled: z.boolean(),
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
  imageModelRef: settingsFields.imageModelRef.default(null),
  transcriptionModelRef: settingsFields.transcriptionModelRef.default(null),
  transcriptionLanguage: settingsFields.transcriptionLanguage.default('auto'),
  speechModelRef: settingsFields.speechModelRef.default(null),
  speechVoice: settingsFields.speechVoice.default(null),
  speechSpeed: settingsFields.speechSpeed.default(1),
  projectMaxSteps: settingsFields.projectMaxSteps.default(100),
  fileSweep: settingsFields.fileSweep.default('off'),
  autoCompact: settingsFields.autoCompact.default(true),
  compactModelRef: settingsFields.compactModelRef.default(null),
  subagentModelRef: settingsFields.subagentModelRef.default(null),
  subagentMaxSteps: settingsFields.subagentMaxSteps.default(30),
  shiftTabModes: settingsFields.shiftTabModes.default(true),
  planFiles: settingsFields.planFiles.default(false),
  planDirectory: settingsFields.planDirectory.default('.harness/plans'),
  outputStyle: settingsFields.outputStyle.default('default'),
  hooksEnabled: settingsFields.hooksEnabled.default(true),
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
