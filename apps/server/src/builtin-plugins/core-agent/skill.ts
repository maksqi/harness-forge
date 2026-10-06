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
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { SkillInput, SkillOutput } from '@harness-forge/shared'
import { skillInputSchema, skillOutputSchema } from '@harness-forge/shared'
import { agentScopeOf } from '../../chat/agent-scope.ts'
import { SKILL_TIMEOUT_MS, textModelOutput } from './common.ts'

export const SKILL_TOOL_NAME = 'skill'

export const SKILL_DESCRIPTION = 'Load a skill: instructions for one kind of task, written by the user, a plugin or the project. The "Skills" block of your instructions lists the available skills with what each one is for. When a request matches a skill\'s description, call this tool with its name before you start and follow the instructions it returns. Only the listed skills can be loaded: skills the user keeps for their own slash commands are not listed. A project skill can come with supporting files in its folder (templates, references, scripts): the result names them, read them with read_file when the instructions point at them. Load a skill once; its instructions stay in the conversation. Do not load skills that do not match the task, and never guess names that are not listed.'

/**
 * The tool error of a call without an agent scope (a sub-agent, which is never offered `skill`, or a context outside a
 * chat run). The text of the P10-0b stub, kept: `index.test.ts` pins it.
 */
export const SKILLS_NOT_AVAILABLE_ERROR = 'Skills are not available yet.'

/** The line the model reads after the content of a project skill. */
export function skillBaseFolderLine(baseDir: string): string {
  return `Base folder: ${baseDir} — read supporting files with read_file`
}

/** The text the model reads for a `skill` output (see the module comment). */
export function skillModelText(output: SkillOutput): string {
  const blocks = [output.content.trimEnd()]
  if (output.truncated)
    blocks.push('(The skill was cut here: it is longer than 64 KB.)')
  if (output.baseDir !== undefined && output.baseDir !== '') {
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
    timeoutMs: SKILL_TIMEOUT_MS,
    async execute(input, c): Promise<SkillOutput> {
      const scope = agentScopeOf(c)
      if (scope === null)
        throw new Error(SKILLS_NOT_AVAILABLE_ERROR)
      return scope.loadSkill(input.name, c.signal)
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(skillOutputSchema, output, skillModelText)
    },
  }
}
