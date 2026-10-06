import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LIMITS } from './limits.ts'
import { CLAUDE_HOME_LIMITS } from './util/claude-import.ts'
import { CLAUDE_PLUGIN_LIMITS } from './util/claude-plugins.ts'
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

  it('declares the Phase 12 group and mirrors CLAUDE_PLUGIN_LIMITS and CLAUDE_HOME_LIMITS', () => {
    expect(LIMITS).toMatchObject({
      marketplacesMax: 50,
      repoArchiveBytes: 52_428_800,
      skillFileReadBytes: 65_536,
      claudeImportPlanTtlMs: 600_000,
      claudeImportPlansMax: 4,
      claudeImportScanTimeoutMs: 10_000,
      promptHookTimeoutDefaultMs: 30_000,
      promptHookPromptMaxChars: 16_384,
      promptHookMaxOutputTokens: 512,
      hookModelCallsMax: 8,
      hookErrorBytes: 16_384,
      transcriptBytesMax: 8_388_608,
      transcriptPartBytes: 65_536,
      transcriptToolResultBytes: 16_384,
      sessionEndBudgetMs: 1500,
      sessionEndBudgetMaxMs: 60_000,
      agentSkillsPreloadMax: 5,
      agentSkillsPreloadBytes: 32_768,
      agentMaxTurnsMax: 200,
      definitionArgumentsMax: 9,
      qualifiedNameMaxChars: 128,
    })
    expect(LIMITS.promptHookPromptMaxChars).toBe(HOOK_LIMITS.promptMaxChars)
    expect(LIMITS.promptHookTimeoutDefaultMs).toBe(HOOK_LIMITS.promptTimeoutDefaultSec * 1000)
    expect(LIMITS.hookErrorBytes).toBe(HOOK_LIMITS.errorMaxChars)
    expect(LIMITS.claudePluginManifestBytes).toBe(CLAUDE_PLUGIN_LIMITS.manifestBytes)
    expect(LIMITS.marketplaceJsonBytes).toBe(CLAUDE_PLUGIN_LIMITS.marketplaceJsonBytes)
    expect(LIMITS.marketplaceEntriesMax).toBe(CLAUDE_PLUGIN_LIMITS.marketplaceEntriesMax)
    expect(LIMITS.claudeComponentsPerKindMax).toBe(CLAUDE_PLUGIN_LIMITS.componentsPerKindMax)
    expect(LIMITS.claudeOutputStylesMax).toBe(CLAUDE_PLUGIN_LIMITS.outputStylesMax)
    expect(LIMITS.claudeUserConfigMax).toBe(CLAUDE_PLUGIN_LIMITS.userConfigMax)
    expect(LIMITS.qualifiedNameMaxChars).toBe(CLAUDE_PLUGIN_LIMITS.qualifiedNameMaxChars)
    expect(LIMITS.qualifiedNameSegmentsMax).toBe(CLAUDE_PLUGIN_LIMITS.qualifiedSegmentsMax)
    expect(LIMITS.claudePluginDiagnosticsMax).toBe(CLAUDE_PLUGIN_LIMITS.diagnosticsMax)
    expect(LIMITS.claudeImportDefinitionBytes).toBe(CLAUDE_HOME_LIMITS.definitionBytes)
    expect(LIMITS.claudeImportDefinitionsPerKindMax).toBe(CLAUDE_HOME_LIMITS.definitionsPerKindMax)
    expect(LIMITS.claudeImportCommandDepthMax).toBe(CLAUDE_HOME_LIMITS.commandDepthMax)
    expect(LIMITS.claudeImportSettingsBytes).toBe(CLAUDE_HOME_LIMITS.settingsBytes)
    expect(LIMITS.claudeMdBytes).toBe(CLAUDE_HOME_LIMITS.claudeMdBytes)
    expect(LIMITS.claudeJsonBytes).toBe(CLAUDE_HOME_LIMITS.claudeJsonBytes)
    expect(LIMITS.claudeImportBytesMax).toBe(CLAUDE_HOME_LIMITS.totalBytes)
    expect(LIMITS.claudeImportItemsMax).toBe(CLAUDE_HOME_LIMITS.itemsMax)
    expect(LIMITS.claudeImportSkippedMax).toBe(CLAUDE_HOME_LIMITS.skippedMax)
    expect(LIMITS.claudeImportSummaryMaxChars).toBe(CLAUDE_HOME_LIMITS.summaryMaxChars)
  })
})
