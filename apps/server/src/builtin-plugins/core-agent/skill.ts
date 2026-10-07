// The `skill` tool of `core-agent` (Phase 10, ADR-045; policy `safe`, no workspace access, timeout 60 s): loads the body
// of one skill of the run's catalog, so the model reads a skill's instructions only when a task matches it (the skills
// block of the instructions lists the names and descriptions). The host offers it only when the run's catalog has at
// least one active skill (`assembleTools({ skillsAvailable })`) and never to a sub-agent (ARCHITECTURE.md 6.25).
//
// P10-0b (C32): the definition (name, description, schema, policy, timeout, model text) is final and frozen. `execute`
// (W10.5) loads the skill through the run's agent scope (`agentScopeOf(c).loadSkill(name, c.signal)`, `chat/skills.ts`):
// a call without a scope (a sub-agent, a context outside a chat run) fails with `SKILLS_NOT_AVAILABLE_ERROR`; an
// unknown, turned-off or unreadable skill is a tool error that lists the available skills.
//
// The model reads the content; for a project skill then "Base folder: <baseDir> — read supporting files with
// read_file" and the supporting files as project-relative paths (`files` are relative to `baseDir`).
//
// Phase 11 (ADR-052, C38): the description says that only the listed skills can be loaded: a skill with
// `disable-model-invocation: true` is left out of the "Skills" block and refused by `loadSkill` (W11.6); the user
// starts it with its slash command.
//
// Phase 12 (ADR-053 / ADR-058; W12.7): `execute` passes the call's options to `loadSkill` (`LoadSkillOptions`: the
// input's `file`, the call's `toolCallId`) bound to the call scope (`chat/skills-call.ts`: the chat id and the run's
// `runSubagent`), so a plugin skill's supporting file is read (`file`), a fork skill (`context: fork`) runs as a
// sub-agent and answers its report, and the body gets `${CLAUDE_SESSION_ID}`. The name may be qualified
// (`review-kit:pdf`) or a unique bare alias. The model text of a plugin skill names its files for `skill { file }`, a
// read file comes with its path. The guard timeout is the `task` tool's (a fork skill's child runs up to its own
// deadline below it); a plain load is unchanged.
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { SkillInput, SkillOutput } from '@harness-forge/shared'
import { skillInputSchema, skillOutputSchema } from '@harness-forge/shared'
import { agentScopeOf } from '../../chat/agent-scope.ts'
import { skillCallOptions } from '../../chat/skills-call.ts'
import { TASK_TIMEOUT_MS, textModelOutput } from './common.ts'

export const SKILL_TOOL_NAME = 'skill'

export const SKILL_DESCRIPTION = 'Load a skill: instructions for one kind of task, written by the user, a plugin or the project. The "Skills" block of your instructions lists the available skills with what each one is for. When a request matches a skill\'s description, call this tool with its name before you start and follow the instructions it returns. Only the listed skills can be loaded: skills the user keeps for their own slash commands are not listed. A skill can come with supporting files in its folder (templates, references, scripts): the result names them; read a project skill\'s files with read_file, and a plugin skill\'s files by calling this tool again with the skill name and file set to the file\'s path. Some skills run as a sub-agent and return its report. Load a skill once; its instructions stay in the conversation. Do not load skills that do not match the task, and never guess names that are not listed.'

/**
 * The tool error of a call without an agent scope (a sub-agent, which is never offered `skill`, or a context outside a
 * chat run). The text of the P10-0b stub, kept: `index.test.ts` pins it.
 */
export const SKILLS_NOT_AVAILABLE_ERROR = 'Skills are not available yet.'

/**
 * Guard timeout of `skill` (Phase 12): the `task` tool's (`TASK_TIMEOUT_MS`, the guard maximum), because a fork skill
 * runs a sub-agent (with its own deadline below it); loading a skill or reading a file takes far less.
 */
export const SKILL_TOOL_TIMEOUT_MS = TASK_TIMEOUT_MS

/** The line the model reads after the content of a project skill. */
export function skillBaseFolderLine(baseDir: string): string {
  return `Base folder: ${baseDir} — read supporting files with read_file`
}

/** The line the model reads before the supporting files of a plugin skill (Phase 12: read with `skill { file }`). */
export function skillFilesLine(name: string, files: readonly string[]): string {
  return `Supporting files (read one with the skill tool: name "${name}", file set to its path): ${files.join(', ')}`
}

/** The text the model reads for a `skill` output (see the module comment). */
export function skillModelText(output: SkillOutput): string {
  if (output.file !== undefined) {
    // Phase 12: one supporting file of the skill (`skill { name, file }`).
    const lines = [`File ${output.file.path} of the skill ${output.name}:`, '', output.file.content.trimEnd()]
    if (output.file.truncated)
      lines.push('', '(The file was cut here: it is longer than 64 KB.)')
    return lines.join('\n')
  }
  const blocks = [output.content.trimEnd()]
  if (output.truncated)
    blocks.push('(The skill was cut here: it is longer than 64 KB.)')
  if (output.fileAccess === 'skill') {
    const files = output.files ?? []
    if (files.length > 0)
      blocks.push(skillFilesLine(output.name, files))
  }
  else if (output.baseDir !== undefined && output.baseDir !== '') {
    const baseDir = output.baseDir.replace(/\/+$/, '')
    const lines = [skillBaseFolderLine(baseDir)]
    const files = output.files ?? []
    if (files.length > 0)
      lines.push(`Supporting files: ${files.map(file => `${baseDir}/${file}`).join(', ')}`)
    blocks.push(lines.join('\n'))
  }
  return blocks.filter(block => block !== '').join('\n\n')
}

export function createSkillTool(): ToolDefinition<SkillInput, SkillOutput> {
  return {
    name: SKILL_TOOL_NAME,
    description: SKILL_DESCRIPTION,
    inputSchema: skillInputSchema,
    policy: 'safe',
    timeoutMs: SKILL_TOOL_TIMEOUT_MS,
    async execute(input, c): Promise<SkillOutput> {
      const scope = agentScopeOf(c)
      if (scope === null)
        throw new Error(SKILLS_NOT_AVAILABLE_ERROR)
      const options = skillCallOptions(
        {
          ...(typeof input.file === 'string' && input.file !== '' ? { file: input.file } : {}),
          ...(typeof c.toolCallId === 'string' && c.toolCallId !== '' ? { toolCallId: c.toolCallId } : {}),
        },
        { chatId: scope.chatId, runSubagent: scope.runSubagent },
      )
      return scope.loadSkill(input.name, c.signal, options)
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(skillOutputSchema, output, skillModelText)
    },
  }
}
