// The compaction summarizer (W9.1-T4): the marker and the focus in the instructions, the transcript as the prompt, the
// setting model and its fallback, the output budget, the usage row and the cost, failures, the summary never at info.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { ModelMessage } from 'ai'
import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../../logger.ts'
import { COMPACT_INSTRUCTIONS_MARKER } from '../markers.ts'
import { summarizeHistory, summaryOutputTokens, transcriptBudgetChars } from './summarize.ts'
import { failingModel, fakeSession, resolvedModel, summaryModel } from './testing.ts'

const messages: ModelMessage[] = [
  { role: 'user', content: 'please fix OLD-7' },
  { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] },
]

function systemOf(call: LanguageModelV4CallOptions | undefined): string {
  return call?.prompt.filter(message => message.role === 'system').map(message => message.content).join('\n') ?? ''
}

function userTextOf(call: LanguageModelV4CallOptions | undefined): string {
  const message = call?.prompt.find(entry => entry.role === 'user')
  return message?.role === 'user' ? message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('') : ''
}

describe('summarizeHistory', () => {
  it('sends the transcript with the marker and the focus, writes one compact usage row and adds the cost', async () => {
    const calls: LanguageModelV4CallOptions[] = []
    const run = resolvedModel('mock:run', summaryModel('  ## Summary\nAll done.  ', calls), 2000)
    const { session, usage } = fakeSession()
    const result = await summarizeHistory({ session, runModel: run, messages, focus: 'keep numbers', signal: new AbortController().signal })
    expect(result).toMatchObject({ summary: '## Summary\nAll done.', modelRef: 'mock:run', costUsd: 0.000018 })
    expect(result.usage.inputTokens).toBe(10)
    const call = calls[0]
    expect(systemOf(call)).toContain(COMPACT_INSTRUCTIONS_MARKER)
    expect(systemOf(call)).toMatch(/^Focus: keep numbers$/m)
    expect(userTextOf(call)).toBe('User:\nplease fix OLD-7\n\nAssistant:\nFixed it.')
    expect(call?.maxOutputTokens).toBe(400)
    expect(call?.tools ?? []).toEqual([])
    expect(usage).toEqual([expect.objectContaining({ chatId: 'chat', messageId: 'msg_a000000000000009', purpose: 'compact', providerId: 'mock', modelId: 'run', inputTokens: 10, outputTokens: 4, costUsd: 0.000018 })])
    expect(session.extraCostUsd).toBe(0.000018)
  })

  it('uses compactModelRef when it resolves', async () => {
    const runCalls: LanguageModelV4CallOptions[] = []
    const settingCalls: LanguageModelV4CallOptions[] = []
    const setting = resolvedModel('mock:small', summaryModel('small summary', settingCalls), 8000)
    const { session, usage, resolved } = fakeSession({ settings: { compactModelRef: 'mock:small' }, models: { 'mock:small': setting } })
    const result = await summarizeHistory({ session, runModel: resolvedModel('mock:run', summaryModel('run summary', runCalls)), messages, focus: null, signal: new AbortController().signal })
    expect(result).toMatchObject({ summary: 'small summary', modelRef: 'mock:small' })
    expect(resolved).toEqual(['mock:small'])
    expect(runCalls).toHaveLength(0)
    expect(settingCalls[0]?.maxOutputTokens).toBe(1600)
    expect(systemOf(settingCalls[0])).not.toMatch(/^Focus: /m)
    expect(usage[0]).toMatchObject({ providerId: 'mock', modelId: 'small', purpose: 'compact' })
  })

  it('falls back to the run model with a warning when compactModelRef cannot be resolved', async () => {
    const memory = createMemoryLogger()
    const { session, resolved } = fakeSession({ settings: { compactModelRef: 'gone:model' }, logger: memory.logger })
    const result = await summarizeHistory({ session, runModel: resolvedModel('mock:run', summaryModel('fallback summary')), messages, focus: null, signal: new AbortController().signal })
    expect(result).toMatchObject({ summary: 'fallback summary', modelRef: 'mock:run' })
    expect(resolved).toEqual(['gone:model'])
    expect(memory.records).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'the compaction model cannot be used; the chat model writes the summary', modelRef: 'gone:model' }))
  })

  it('caps the summary, and an empty summary is a failure', async () => {
    const long = await summarizeHistory({ session: fakeSession().session, runModel: resolvedModel('mock:run', summaryModel('s'.repeat(LIMITS.compactionSummaryMaxChars + 50))), messages, focus: null, signal: new AbortController().signal })
    expect(long.summary).toHaveLength(LIMITS.compactionSummaryMaxChars)
    await expect(summarizeHistory({ session: fakeSession().session, runModel: resolvedModel('mock:run', summaryModel('   ')), messages, focus: null, signal: new AbortController().signal }))
      .rejects
      .toMatchObject({ code: 'provider_error', message: 'The model wrote an empty summary.' })
  })

  it('rejects with the mapped error of a failed call and writes no usage row', async () => {
    const { session, usage } = fakeSession()
    await expect(summarizeHistory({ session, runModel: resolvedModel('mock:run', failingModel(new Error('summarizer down'))), messages, focus: null, signal: new AbortController().signal }))
      .rejects
      .toMatchObject({ code: 'provider_error', message: 'summarizer down' })
    expect(usage).toEqual([])
    expect(session.extraCostUsd).toBe(0)
  })

  it('keeps the summary even when the usage row cannot be stored', async () => {
    const { session } = fakeSession({ usageFails: true })
    const result = await summarizeHistory({ session, runModel: resolvedModel('mock:run', summaryModel('kept')), messages, focus: null, signal: new AbortController().signal })
    expect(result.summary).toBe('kept')
  })

  it('never logs the summary or the transcript at info (debug only, counts only)', async () => {
    const memory = createMemoryLogger({ level: 'info' })
    const { session } = fakeSession({ logger: memory.logger })
    await summarizeHistory({ session, runModel: resolvedModel('mock:run', summaryModel('SECRET-SUMMARY-TEXT')), messages, focus: null, signal: new AbortController().signal })
    expect(memory.text()).not.toContain('SECRET-SUMMARY-TEXT')
    expect(memory.text()).not.toContain('OLD-7')
    const debug = createMemoryLogger({ level: 'debug' })
    await summarizeHistory({ session: fakeSession({ logger: debug.logger }).session, runModel: resolvedModel('mock:run', summaryModel('SECRET-SUMMARY-TEXT')), messages, focus: null, signal: new AbortController().signal })
    expect(debug.text()).not.toContain('SECRET-SUMMARY-TEXT')
  })
})

describe('summarizer budgets', () => {
  it('clamps the output to 0.2 of the window within 256..8192', () => {
    expect(summaryOutputTokens(2000)).toBe(400)
    expect(summaryOutputTokens(500)).toBe(256)
    expect(summaryOutputTokens(1_000_000)).toBe(8192)
    expect(summaryOutputTokens(null)).toBe(6400)
  })

  it('gives the transcript 0.85 of the window, less the instructions and the output when they would not fit', () => {
    expect(transcriptBudgetChars(200_000, 'i'.repeat(400), 8192)).toBe(170_000 * 4)
    expect(transcriptBudgetChars(2000, 'i'.repeat(400), 400)).toBe((2000 - 400 - 100) * 4)
    expect(transcriptBudgetChars(100, 'i'.repeat(4000), 256)).toBe(0)
  })
})
