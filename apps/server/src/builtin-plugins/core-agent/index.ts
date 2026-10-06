// Builtin plugin `core-agent` (Phase 9, ADR-041 / ADR-043; Phase 10, ADR-045 / ADR-046 / ADR-047; PLUGINS.md 1,
// ARCHITECTURE.md 6.19, 6.22 and 6.25): the agent tools, registered through the public plugin SDK. Version 1.0.0,
// `engines.harness` `^1.4.0` (plugin API 1.4.0: `task` takes `background` and any catalog agent type; 1.3.0 gave `task`
// its async-generator `execute`), no permissions, no settings (the agent settings live in Settings -> General:
// `autoCompact`, `compactModelRef`, `subagentModelRef`, `subagentMaxSteps`, `planFiles`, `planDirectory`). None of the
// tools declares workspace access, so they are offered in every chat with tools; the host narrows that
// (`chat/modes.ts`, `chat/tools.ts`): `exit_plan_mode` only in plan mode, `task` and `skill` never inside a sub-agent,
// `skill` only when the run's catalog has skills. What the tools need from the server (the run's permission mode, the
// sub-agent runner, the skill loader, the plan file writer) comes through the private side channel
// `chat/agent-scope.ts`, and the server recognizes them by owner (`pluginId === 'core-agent'`), never by name alone.
//
// Phase 11 (ADR-051, C38): the builtin output styles (`styles.ts`) live here too, like the builtin agent types: the
// catalog lists them as builtin entries. The manifest keeps `engines.harness` `^1.4.0`: `core-agent` uses no plugin API
// 1.5.0 member (the builtin styles are read by the server, never registered through `ctx.outputStyles`).
//
// File layout (P9-0b skeleton by C27, P10-0b by C32, P11-0b by C38; the manifest, names, schemas, descriptions,
// policies, timeouts, model texts and the builtin styles are FROZEN after Gate P11-0b; one module per tool, each exporting
// `create<Tool>Tool()`, its name and its model text):
//
//   index.ts           manifest, `createAgentTools()` (registration order = `AGENT_TOOL_NAMES`), setup        C32
//   common.ts          guard timeouts, mode labels, `agentToolNotImplemented`, `textModelOutput`                C27
//   agents.ts          the builtin agent types `explore` and `general` (the catalog's builtin entries)         C32
//   styles.ts          the builtin output styles `default`, `explanatory`, `learning` (catalog builtins)      C38
//   todo-write.ts      `todo_write`      policy safe,   60 s                                                  W9.4
//   exit-plan-mode.ts  `exit_plan_mode`  policy always, 60 s; the plan file: W10.5 (`savePlan`)             W9.3
//   task.ts            `task`            policy safe,  600 s; async generator over `runSubagent`           W9.5 / W10.3
//   skill.ts           `skill`           policy safe,   60 s; execute: W10.5 (`loadSkill`); P11: model-invocable
//                      skills only (the filter: W11.6)                                                  W10.5 / W11.6
//
// Input and output schemas come from `@harness-forge/shared` (`AGENT_TOOL_SCHEMAS`); `toModelOutput` builds the model's
// text only from the stored output.
import type { PluginManifest, ToolDefinition } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { createExitPlanModeTool } from './exit-plan-mode.ts'
import { createSkillTool } from './skill.ts'
import { createTaskTool } from './task.ts'
import { createTodoWriteTool } from './todo-write.ts'

export { BUILTIN_AGENT_DEFINITIONS, builtinAgentDefinition } from './agents.ts'
export type { BuiltinAgentDefinition } from './agents.ts'
export {
  agentToolNotImplemented,
  EXIT_PLAN_MODE_TIMEOUT_MS,
  SKILL_TIMEOUT_MS,
  TASK_TIMEOUT_MS,
  TODO_WRITE_TIMEOUT_MS,
  TOOL_MODE_LABELS,
} from './common.ts'
export { createExitPlanModeTool, EXIT_PLAN_MODE_DESCRIPTION, EXIT_PLAN_MODE_TOOL_NAME, exitPlanModeModelText } from './exit-plan-mode.ts'
export { createSkillTool, SKILL_DESCRIPTION, SKILL_TOOL_NAME, skillBaseFolderLine, skillModelText, SKILLS_NOT_AVAILABLE_ERROR } from './skill.ts'
export { BUILTIN_STYLE_DEFINITIONS, builtinStyleDefinition } from './styles.ts'
export type { BuiltinStyleDefinition } from './styles.ts'
export {
  createTaskTool,
  TASK_DESCRIPTION,
  TASK_TOOL_NAME,
  TASK_UNAVAILABLE_ERROR,
  taskBackgroundModelText,
  taskModelOutputSchema,
  taskModelText,
  taskUnavailableOutput,
} from './task.ts'
export { createTodoWriteTool, TODO_WRITE_DESCRIPTION, TODO_WRITE_TOOL_NAME, todoWriteModelText } from './todo-write.ts'

/** The id of the plugin; server code recognizes the agent tools by this owner. */
export const CORE_AGENT_PLUGIN_ID = 'core-agent'

export const manifest = {
  manifestVersion: 1,
  id: CORE_AGENT_PLUGIN_ID,
  name: 'Agent tools',
  version: '1.0.0',
  description: 'Builtin agent tools: todo_write (a todo list the user sees), exit_plan_mode (plan approval), task (sub-agents, also in the background) and skill (loads a skill).',
  engines: { harness: '^1.4.0' },
  main: 'index.ts',
} satisfies PluginManifest

/** The agent tools in registration order (`AGENT_TOOL_NAMES`). */
export function createAgentTools(): ToolDefinition[] {
  return [createTodoWriteTool(), createExitPlanModeTool(), createTaskTool(), createSkillTool()]
}

export default definePlugin({
  setup(ctx) {
    for (const tool of createAgentTools())
      ctx.tools.register(tool)
  },
})
