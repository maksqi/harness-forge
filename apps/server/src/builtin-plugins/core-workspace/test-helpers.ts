// Test helpers of the `core-workspace` tools: a temp project folder (a canonical realpath: macOS `/var` is a link to
// `/private/var`) and the call context of a tool in a project chat. Test-only.
import type { ToolCallContext, ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A tool whose `execute` returns a promise. Plugin API 1.3.0 (ADR-043) lets `execute` also return a plain value or an
 * async iterable (preliminary outputs); the core tools return promises, so tests narrow them to await the output.
 */
export type PromiseTool<I, O> = Omit<ToolDefinition<I, O>, 'execute'> & { execute: (input: I, c: ToolCallContext) => Promise<O> }

/** The same tool, typed as returning a promise from `execute` (no runtime change). */
export function promiseTool<I, O>(tool: ToolDefinition<I, O>): PromiseTool<I, O> {
  return tool as PromiseTool<I, O>
}

export interface TestWorkspace {
  /** The project folder (realpath). */
  root: string
  /** The call context of a tool in a chat of this project. */
  context: (signal?: AbortSignal) => ToolCallContext
  /** Writes files (parent folders created); values are text or bytes. */
  write: (files: Record<string, string | Uint8Array>) => Promise<void>
  cleanup: () => Promise<void>
}

export async function createTestWorkspace(): Promise<TestWorkspace> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  const root = join(base, 'project')
  await mkdir(root)
  return {
    root,
    context: (signal = new AbortController().signal) => ({
      chatId: '0199a8f0-0000-7000-8000-000000000001',
      modelRef: 'mock:workspace',
      toolCallId: 'call_1',
      messages: [],
      signal,
      workspace: { projectId: 'prj_AAAAAAAAAAAAAAAA', name: 'Demo', root },
    }),
    async write(files) {
      for (const [path, content] of Object.entries(files)) {
        const absolute = join(root, path)
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, content)
      }
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

/** The context of a call without a project folder. */
export function contextWithoutWorkspace(): ToolCallContext {
  return { chatId: '0199a8f0-0000-7000-8000-000000000001', modelRef: 'mock:workspace', toolCallId: 'call_1', messages: [], signal: new AbortController().signal }
}

/** The model text of a stored output (a JSON round trip, as the host stores it). */
export async function modelTextOf<I, O>(tool: ToolDefinition<I, O>, output: O, input: I): Promise<string> {
  const stored = JSON.parse(JSON.stringify(output)) as O
  const result: ToolResultOutput = await tool.toModelOutput!(stored, { toolCallId: 'call_1', input })
  if (result.type !== 'text')
    throw new Error(`expected a text model output, got ${result.type}`)
  return result.value
}
