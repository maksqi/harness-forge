import type { ToolPartLike } from '../chat-format'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { taskInput, taskOutput, taskPart } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import TaskBlock from './TaskBlock.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))

beforeEach(() => {
  mock.api = createMockApi()
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
})

function block(part: ToolPartLike, streaming = true, superseded = false) {
  return mount({
    render: () => h(TooltipProvider, null, { default: () => h(TaskBlock, { part, streaming, superseded }) }),
  }, { attachTo: document.body })
}

function root(wrapper: ReturnType<typeof block>) {
  return wrapper.get(`[data-testid="${testIds.taskBlock}"]`)
}

describe('taskBlock (P9-0b stub)', () => {
  it('renders its root with the state and the kind of the sub-agent', () => {
    expect(root(block(taskPart({ preliminary: true }) as ToolPartLike)).attributes()).toMatchObject({ 'data-state': 'running', 'data-kind': 'explore' })
    expect(root(block(taskPart({ preliminary: true }) as ToolPartLike, false)).attributes('data-state')).toBe('aborted')
    const general = taskPart({ input: taskInput({ type: 'general' }), output: taskOutput({ type: 'general', status: 'limit' }) }) as ToolPartLike
    expect(root(block(general, false)).attributes()).toMatchObject({ 'data-state': 'limit', 'data-kind': 'general' })
    const unparsable = { type: 'tool-task', toolCallId: 'call_x', state: 'output-error', input: { nope: true }, errorText: 'boom' } as ToolPartLike
    const failed = root(block(unparsable, false))
    expect(failed.attributes('data-state')).toBe('failed')
    expect(failed.attributes('data-kind')).toBeUndefined()
  })

  it('passes the approval of a task call that asks on', async () => {
    const asking = { type: 'tool-task', toolCallId: 'call_task_1', state: 'approval-requested', input: taskInput(), approval: { id: 'appr_task' } } as ToolPartLike
    const wrapper = block(asking, false)
    expect(root(wrapper).attributes('data-state')).toBe('approval')
    await wrapper.get(`[data-testid="${testIds.toolApprovalAllow}"]`).trigger('click')
    await flushPromises()
    expect(wrapper.getComponent(TaskBlock).emitted('approval')).toEqual([[{ id: 'appr_task', approved: true, toolName: 'task', alwaysAllow: false }]])
    expect(root(block(asking, false, true)).attributes('data-state')).toBe('denied')
  })
})
