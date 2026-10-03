// Builtin plugin `core-agent` (Phase 9, ADR-041 / ADR-043, PLUGINS.md 1, ARCHITECTURE.md 6.19 and 6.22): the agent
// tools, registered through the public plugin SDK (plugin API 1.3.0: `task` has an async-generator `execute`).
// Version 1.0.0, `engines.harness` `^1.3.0`, no permissions, no settings (the agent settings live in Settings ->
// General: `autoCompact`, `compactModelRef`, `subagentModelRef`, `subagentMaxSteps`). None of the tools declares
// workspace access, so they are offered in every chat with tools; the host narrows that (`chat/modes.ts`):
// `exit_plan_mode` only in plan mode, `task` never inside a sub-agent. What the tools need from the server (the run's
// permission mode, the sub-agent runner) comes through the private side channel `chat/agent-scope.ts`, and the server
// recognizes them by owner (`pluginId === 'core-agent'`), never by name alone.
//
// File layout (P9-0b skeleton by C27; the manifest, names, schemas, descriptions, policies, timeouts and model texts are
// FROZEN after Gate P9-0b; one module per tool, each exporting `create<Tool>Tool()`, its name and its model text):
//
//   index.ts           manifest, `createAgentTools()` (registration order = `AGENT_TOOL_NAMES`), setup        C27
//   common.ts          guard timeouts, mode labels, `agentToolNotImplemented`, `textModelOutput`                C27
//   todo-write.ts      `todo_write`      policy safe,   60 s; execute: W9.4                                   W9.4
//   exit-plan-mode.ts  `exit_plan_mode`  policy always, 60 s; execute: W9.3 (the agent scope's `toolMode`)    W9.3
//   task.ts            `task`            policy safe,  600 s; async generator over `runSubagent` (W9.5)        W9.5
//
// Input and output schemas come from `@harness-forge/shared` (`AGENT_TOOL_SCHEMAS`); `toModelOutput` builds the model's
// text only from the stored output.
import type { PluginManifest, ToolDefinition } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { createExitPlanModeTool } from './exit-plan-mode.ts'
import { createTaskTool } from './task.ts'
import { createTodoWriteTool } from './todo-write.ts'

export {
  agentToolNotImplemented,
  EXIT_PLAN_MODE_TIMEOUT_MS,
  TASK_TIMEOUT_MS,
  TODO_WRITE_TIMEOUT_MS,
  TOOL_MODE_LABELS,
} from './common.ts'
export { createExitPlanModeTool, EXIT_PLAN_MODE_DESCRIPTION, EXIT_PLAN_MODE_TOOL_NAME, exitPlanModeModelText } from './exit-plan-mode.ts'
export {
  createTaskTool,
  TASK_DESCRIPTION,
  TASK_TOOL_NAME,
  TASK_UNAVAILABLE_ERROR,
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
  description: 'Builtin agent tools: todo_write (a todo list the user sees), exit_plan_mode (plan approval) and task (sub-agents).',
  engines: { harness: '^1.3.0' },
  main: 'index.ts',
} satisfies PluginManifest

/** The agent tools in registration order (`AGENT_TOOL_NAMES`). */
export function createAgentTools(): ToolDefinition[] {
  return [createTodoWriteTool(), createExitPlanModeTool(), createTaskTool()]
}

export default definePlugin({
  setup(ctx) {
    for (const tool of createAgentTools())
      ctx.tools.register(tool)
  },
})
