import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LIMITS } from './limits.ts'
import { COMMAND_TEMPLATE_LIMITS } from './util/command-template.ts'
import { DEFINITION_LIMITS } from './util/definitions.ts'
import { HOOK_LIMITS } from './util/hooks.ts'
import { MCP_CONFIG_LIMITS } from './util/mcp-config.ts'
import { TRUST_LIMITS } from './util/trust.ts'

describe('limits', () => {
  it('imports nothing (the util modules import it, so an import from util/ would close a cycle)', () => {
    const text = readFileSync(new URL('./limits.ts', import.meta.url), 'utf8')
    expect(text).not.toMatch(/^import /m)
  })

  it('mirrors DEFINITION_LIMITS (Phase 10)', () => {
    expect(LIMITS.customizationContentBytes).toBe(DEFINITION_LIMITS.contentBytes)
    expect(LIMITS.customizationFrontmatterBytes).toBe(DEFINITION_LIMITS.frontmatterBytes)
    expect(LIMITS.customizationDescriptionMaxChars).toBe(DEFINITION_LIMITS.descriptionMaxChars)
  })

  it('declares the Phase 11 group with the values of the contract seed', () => {
    expect(LIMITS).toMatchObject({
      hookTimeoutDefaultMs: 60_000,
      hookTimeoutMaxMs: 600_000,
      hooksPerEventMax: 20,
      personalHooksMax: 100,
      hookProcessesMax: 16,
      hookPayloadBytes: 262_144,
      hookStdoutBytes: 65_536,
      hookStderrBytes: 16_384,
      hookContextMaxChars: 10_000,
      hookReasonMaxChars: 2000,
      hookUpdatedInputBytes: 65_536,
      hookContinuationsMax: 5,
      subagentStopContinuationsMax: 2,
      hookRunsKept: 200,
      projectSettingsFileBytes: 262_144,
      projectHookItemsMax: 100,
      projectMcpServersMax: 20,
      projectMcpVariablesMax: 50,
      projectMcpConnectWaitMs: 5000,
      projectMcpIdleMs: 600_000,
      trustItemsMax: 200,
      trustRefFilesMax: 8,
      trustRefFileBytes: 1_048_576,
      commandShellSpansMax: 10,
      commandShellTimeoutMs: 30_000,
      commandShellTotalMs: 60_000,
      commandShellOutputBytes: 16_384,
      commandFileRefsMax: 10,
      commandFileRefBytes: 32_768,
      pluginHooksMax: 50,
      pluginOutputStylesMax: 20,
      trustApproveItemsMax: 50,
    })
  })

  it('mirrors HOOK_LIMITS', () => {
    expect(LIMITS.hookTimeoutDefaultMs).toBe(HOOK_LIMITS.timeoutDefaultSec * 1000)
    expect(LIMITS.hookTimeoutMaxMs).toBe(HOOK_LIMITS.timeoutMaxSec * 1000)
    expect(LIMITS.personalHooksMax).toBe(HOOK_LIMITS.itemsMax)
    expect(LIMITS.projectHookItemsMax).toBe(HOOK_LIMITS.itemsMax)
    expect(LIMITS.projectSettingsFileBytes).toBe(HOOK_LIMITS.configBytes)
    expect(LIMITS.hookCommandMaxChars).toBe(HOOK_LIMITS.commandMaxChars)
    expect(LIMITS.hookMatcherMaxChars).toBe(HOOK_LIMITS.matcherMaxChars)
    expect(LIMITS.hookPayloadBytes).toBe(HOOK_LIMITS.payloadBytes)
    expect(LIMITS.hookContextMaxChars).toBe(HOOK_LIMITS.contextMaxChars)
    expect(LIMITS.hookReasonMaxChars).toBe(HOOK_LIMITS.reasonMaxChars)
    expect(LIMITS.hookSystemMessageMaxChars).toBe(HOOK_LIMITS.systemMessageMaxChars)
    expect(LIMITS.hookUpdatedInputBytes).toBe(HOOK_LIMITS.updatedInputBytes)
  })

  it('mirrors TRUST_LIMITS, MCP_CONFIG_LIMITS and COMMAND_TEMPLATE_LIMITS', () => {
    expect(LIMITS.trustRefFilesMax).toBe(TRUST_LIMITS.refFilesMax)
    expect(LIMITS.trustRefFileBytes).toBe(TRUST_LIMITS.refFileBytes)
    expect(LIMITS.projectMcpFileBytes).toBe(MCP_CONFIG_LIMITS.fileBytes)
    expect(LIMITS.projectMcpServersMax).toBe(MCP_CONFIG_LIMITS.serversMax)
    expect(LIMITS.projectMcpVariablesMax).toBe(MCP_CONFIG_LIMITS.variablesMax)
    expect(LIMITS.projectMcpVariableValueMaxChars).toBe(MCP_CONFIG_LIMITS.valueMaxChars)
    expect(LIMITS.commandShellSpansMax).toBe(COMMAND_TEMPLATE_LIMITS.shellSpansMax)
    expect(LIMITS.commandShellOutputBytes).toBe(COMMAND_TEMPLATE_LIMITS.shellOutputBytes)
    expect(LIMITS.commandFileRefsMax).toBe(COMMAND_TEMPLATE_LIMITS.fileRefsMax)
    expect(LIMITS.commandFileRefBytes).toBe(COMMAND_TEMPLATE_LIMITS.fileRefBytes)
  })
})
